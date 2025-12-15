// src/app/services/sqlite.service.ts - CÓDIGO FINAL COMPLETO

import { Injectable, inject } from '@angular/core';
import { CapacitorSQLite, SQLiteDBConnection, SQLiteConnection } from '@capacitor-community/sqlite';
// Importa los tipos (Asegúrese de que estos tipos existan en database.types.ts)
import {
  Ingrediente,
  UnidadMedida,
  Cliente,
  Pedido,
  Cotizacion
} from '../models/database.types';

import { Platform } from '@ionic/angular';

@Injectable({
  providedIn: 'root'
})
export class SqliteService {

  private _isSQLiteActive: boolean = false;
  private db!: SQLiteDBConnection;

  private sqliteConnection!: SQLiteConnection;

  public get isSQLiteActive(): boolean {
    return this._isSQLiteActive;
  }

  private platform = inject(Platform); // ⬅️ Inyección
  private isNative: boolean;

  constructor() {
    // 🔑 1. Determinar si estamos en un entorno nativo (Capacitor/Cordova)
    // Usar 'capacitor' es el chequeo más seguro para el entorno móvil.
    this.isNative = this.platform.is('capacitor');

    console.log(`[SQLiteService] Entorno Nativo detectado: ${this.isNative ? 'SÍ' : 'NO'}`);

    if (this.isNative) {
      // 🔑 CORRECCIÓN 3: Inicializar sqliteConnection AQUI
      this.sqliteConnection = new SQLiteConnection(CapacitorSQLite);
      // 2. Inicializar la conexión y la DB solo si es nativo
      this.initializeDatabase(); // Llamar al método principal
    } else {
      // 3. En Web/Dev, simplemente logueamos y no hacemos nada más.
      console.log('[SQLiteService] Ejecutando en Web/Dev. SQLite deshabilitado. Usando Supabase.');
    }
  }

  // ===============================================
  // 🔑 MÉTODOS DE INICIALIZACIÓN Y TABLAS
  // ===============================================

  /** Inicializa la base de datos, abre la conexión y crea las tablas. */
  public async initializeDatabase(): Promise<void> {

    try {
      console.log('SQLITE: Intentando conectar a la DB.');

      this.db = await this.sqliteConnection.createConnection(
          'sippa_db',
          false,
          'no-encryption',
          1,
          false);
      await this.db.open();

      // 2. Crear todas las tablas necesarias (UUID -> TEXT en SQLite)
      const createTablesSQL = `
              -- Tablas de Datos Maestras y Transaccionales 
              CREATE TABLE IF NOT EXISTS cliente (cli_id TEXT PRIMARY KEY, cli_nombre TEXT, cli_apellido TEXT, cli_telefono TEXT, cli_instagram TEXT, deleted_at TEXT);
              
              CREATE TABLE IF NOT EXISTS unidad_medida (unmed_id TEXT PRIMARY KEY, unmed_nombre TEXT);

              -- is_deleted es INTEGER (0/1) en SQLite
              -- CORRECCIÓN: ing_cantidad_base ahora es INTEGER
              CREATE TABLE IF NOT EXISTS ingredientes (ing_id TEXT PRIMARY KEY, ing_nombre TEXT, ing_precio REAL, is_deleted INTEGER, unmed_id TEXT, ing_cantidad_base INTEGER);

              -- CORRECCIÓN CRÍTICA: cot_fecha_creacion -> cot_fecha, y ELIMINADO cli_id
              CREATE TABLE IF NOT EXISTS cotizacion (cot_id TEXT PRIMARY KEY, cot_fecha TEXT, cot_total REAL, cot_nombre TEXT); 
              
              CREATE TABLE IF NOT EXISTS cotizacion_detalle (cot_id TEXT, ing_id TEXT, cantidad_usada REAL, precio_unitario_fijo REAL, PRIMARY KEY (cot_id, ing_id));

              CREATE TABLE IF NOT EXISTS estado_pedido (est_id TEXT PRIMARY KEY, est_nombre TEXT); 
              
              CREATE TABLE IF NOT EXISTS pedido (ped_id TEXT PRIMARY KEY, ped_fecha_entrega TEXT, ped_precio REAL, cli_id TEXT, cot_id TEXT, est_id TEXT);

              -- Tabla de Auth local
              CREATE TABLE IF NOT EXISTS local_auth (email TEXT PRIMARY KEY);
              
              -- Tablas Delta (Para Sync Up)
              CREATE TABLE IF NOT EXISTS delta_clientes (delta_id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, payload_json TEXT, timestamp INTEGER);
              CREATE TABLE IF NOT EXISTS delta_cotizaciones (delta_id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, payload_json TEXT, timestamp INTEGER);
              CREATE TABLE IF NOT EXISTS delta_pedidos (delta_id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, payload_json TEXT, timestamp INTEGER);
          `;
      await this.db.execute(createTablesSQL);

      this._isSQLiteActive = true;
      console.log('SQLITE: Base de datos inicializada y tablas creadas con éxito.');

    } catch (e) {
      console.error('SQLITE ERROR al inicializar:', e);
      this._isSQLiteActive = false;
    }
  }

  // ===============================================
  // 🔑 MÉTODOS DE AUTENTICACIÓN LOCAL
  // ===============================================

  /** Guarda el email local para permitir el acceso offline. */
  public async setLocalAuth(email: string): Promise<void> {
    if (!this._isSQLiteActive) return;
    try {
      await this.db.run('DELETE FROM local_auth;');
      await this.db.run('INSERT INTO local_auth (email) VALUES (?)', [email]);
      console.log(`SQLITE: Email de sesión guardado: ${email}`);
    } catch (e) {
      console.error('SQLITE ERROR al guardar Auth:', e);
    }
  }

  /** Revisa si hay una sesión guardada localmente (Usado por AuthGuard). */
  public async hasLocalAuthEntry(): Promise<boolean> {
    if (!this._isSQLiteActive) return false;
    try {
      const res = await this.db.query('SELECT COUNT(*) AS count FROM local_auth;');

      // 🔑 CORRECCIÓN: Usamos encadenamiento opcional para acceder a 'count' de forma segura.
      // Si res.values, res.values[0] o .count es null/undefined, devuelve 0.
      const count = res.values?.[0]?.count ?? 0;

      return count > 0;

    } catch (e) {
      console.error("SQLITE ERROR en hasLocalAuthEntry:", e);
      return false; // Retorna false ante cualquier error de DB.
    }
  }

  /** Revisa las credenciales locales (Por ahora, siempre devuelve false). */
  public async checkLocalAuth(email: string): Promise<boolean> {
    console.log(`SQLITE: Verificando sesión local para ${email} (Retorna false por diseño).`);
    return false;
  }


  // ===============================================
  // 🔑 MÉTODOS DE LECTURA LOCAL (OFFLINE)
  // ===============================================

  public async getIngredientes(searchText: string = ''): Promise<Ingrediente[]> {
    if (!this._isSQLiteActive) return [];
    console.log(`SQLITE: Consultando ingredientes locales.`);
    try {
      const query = `
                SELECT i.*, u.unmed_nombre 
                FROM ingredientes i 
                JOIN unidad_medida u ON i.unmed_id = u.unmed_id
                WHERE i.ing_nombre LIKE ? AND i.is_deleted = 0;
            `;
      const res = await this.db.query(query, [`%${searchText}%`]);
      return (res.values as Ingrediente[]) || [];
    } catch (e) {
      console.error("SQLITE ERROR en getIngredientes:", e);
      return [];
    }
  }

  public async getUnidadesMedida(): Promise<UnidadMedida[]> {
    if (!this._isSQLiteActive) return [];
    console.log('SQLITE: Consultando unidades de medida locales.');
    try {
      const res = await this.db.query('SELECT * FROM unidad_medida ORDER BY unmed_nombre ASC;');
      return (res.values as UnidadMedida[]) || [];
    } catch (e) {
      console.error("SQLITE ERROR en getUnidadesMedida:", e);
      return [];
    }
  }

  public async getPedidosLocal(): Promise<Pedido[]> {
    if (!this._isSQLiteActive) return [];
    console.log("SQLITE: Consultando pedidos locales.");
    try {
      const res = await this.db.query('SELECT * FROM pedido ORDER BY ped_fecha_entrega DESC;');
      return (res.values as Pedido[]) || [];
    } catch (e) {
      console.error("SQLITE ERROR en getPedidosLocal:", e);
      return [];
    }
  }

  public async getClientesLocal(): Promise<Cliente[]> {
    if (!this._isSQLiteActive) return [];
    console.log("SQLITE: Consultando clientes locales.");
    try {
      const res = await this.db.query('SELECT * FROM cliente WHERE deleted_at IS NULL ORDER BY cli_nombre ASC;');
      return (res.values as Cliente[]) || [];
    } catch (e) {
      console.error("SQLITE ERROR en getClientesLocal:", e);
      return [];
    }
  }

  public async getCotizacionesLocal(): Promise<Cotizacion[]> {
    if (!this._isSQLiteActive) return [];
    console.log("SQLITE: Consultando cotizaciones locales con detalles.");

    try {
      // 🚨 CORRECCIÓN 1: Cambiar el ORDER BY al nuevo nombre de columna: cot_fecha
      const cotizacionesRes = await this.db.query('SELECT * FROM cotizacion ORDER BY cot_fecha DESC;');
      const cotizaciones: Cotizacion[] = (cotizacionesRes.values as Cotizacion[]) || [];

      for (const cot of cotizaciones) {
        const detallesRes = await this.db.query(
            'SELECT * FROM cotizacion_detalle WHERE cot_id = ?',
            [cot.cot_id]
        );
        // Asumimos que Cotizacion tiene una propiedad 'detalles'
        (cot as any).detalles = detallesRes.values;
      }

      return cotizaciones;
    } catch (e) {
      console.error("SQLITE ERROR en getCotizacionesLocal:", e);
      return [];
    }
  }

  // ===============================================
  // 🔑 MÉTODOS DE SINCRONIZACIÓN (SYNC UP/DOWN)
  // ===============================================

  /** 🚨 Sync Down: Borra y reemplaza todos los datos. */
  public async saveFullSyncDown(
      ingredientes: Ingrediente[],
      unidades: UnidadMedida[],
      clientes: Cliente[],
      cotizaciones: any[],
      pedidos: Pedido[],
      estados: any[] // Se requiere que el SyncService obtenga esto
  ): Promise<void> {
    if (!this._isSQLiteActive) return;
    console.log(`SQLITE: Iniciando Full Sync Down para ${clientes.length} Clientes, ${pedidos.length} Pedidos, etc.`);

    try {
      await this.db.beginTransaction();

      // 1. Borrar todas las tablas
      const tablesToClear = ['cliente', 'pedido', 'cotizacion', 'cotizacion_detalle', 'ingredientes', 'unidad_medida', 'estado_pedido'];
      for (const table of tablesToClear) {
        await this.db.run(`DELETE FROM ${table};`);
      }

      // 2. Insertar Estados de Pedido
      for (const e of estados) {
        await this.db.run('INSERT INTO estado_pedido (est_id, est_nombre) VALUES (?, ?)', [e.est_id, e.est_nombre]);
      }

      // 3. Insertar Unidades de Medida
      for (const u of unidades) {
        await this.db.run('INSERT INTO unidad_medida (unmed_id, unmed_nombre) VALUES (?, ?)', [u.unmed_id, u.unmed_nombre]);
      }

      // 4. Insertar Ingredientes
      for (const i of ingredientes) {
        await this.db.run(
            // 🚨 CORRECCIÓN: ing_cantidad_base es INTEGER en la tabla SQL.
            'INSERT INTO ingredientes (ing_id, ing_nombre, ing_precio, unmed_id, is_deleted, ing_cantidad_base) VALUES (?, ?, ?, ?, ?, ?)',
            [i.ing_id, i.ing_nombre, i.ing_precio, i.unmed_id, i.is_deleted ? 1 : 0, i.ing_cantidad_base]
        );
      }

      // 5. Insertar Clientes
      for (const c of clientes) {
        await this.db.run(
            'INSERT INTO cliente (cli_id, cli_nombre, cli_apellido, cli_telefono, cli_instagram, deleted_at) VALUES (?, ?, ?, ?, ?, ?)',
            [c.cli_id, c.cli_nombre, c.cli_apellido, c.cli_telefono, c.cli_instagram || null, c.deleted_at || null]
        );
      }

      // 6. Insertar Cotizaciones y sus Detalles
      for (const cot of cotizaciones) {
        // 🚨 CORRECCIÓN CRÍTICA: Eliminamos 'cli_id' y cambiamos 'cot_fecha_creacion' a 'cot_fecha'.
        // Cabecera
        await this.db.run(
            'INSERT INTO cotizacion (cot_id, cot_nombre, cot_total, cot_fecha) VALUES (?, ?, ?, ?)',
            [cot.cot_id, cot.cot_nombre, cot.cot_total, cot.cot_fecha]
        );

        // Detalles
        if (cot.cotizacion_detalle && Array.isArray(cot.cotizacion_detalle)) {
          for (const det of cot.cotizacion_detalle) {
            await this.db.run(
                'INSERT INTO cotizacion_detalle (cot_id, ing_id, cantidad_usada, precio_unitario_fijo) VALUES (?, ?, ?, ?)',
                [cot.cot_id, det.ing_id, det.cantidad_usada, det.precio_unitario_fijo]
            );
          }
        }
      }

      // 7. Insertar Pedidos
      for (const ped of pedidos) {
        await this.db.run(
            'INSERT INTO pedido (ped_id, cli_id, cot_id, ped_precio, ped_fecha_entrega, est_id) VALUES (?, ?, ?, ?, ?, ?)',
            [ped.ped_id, ped.cli_id, ped.cot_id, ped.ped_precio, ped.ped_fecha_entrega, ped.est_id]
        );
      }

      await this.db.commitTransaction();
      console.log(`SQLITE: Full Sync Down completado y guardado con éxito.`);

    } catch (e) {
      await this.db.rollbackTransaction();
      console.error("SQLITE ERROR en saveFullSyncDown (Rollback):", e);
      throw new Error("Fallo la transacción de Full Sync Down.");
    }
  }

  /** Sync Up: Obtiene deltas pendientes. */
  public async getSyncDeltas(): Promise<any> {
    if (!this._isSQLiteActive) return { clientes: [], cotizaciones: [], pedidos: [] };
    console.log('SQLITE: Obteniendo deltas para Sync Up (Implementación real).');

    try {
      const clientesRes = await this.db.query('SELECT delta_id, action, payload_json FROM delta_clientes ORDER BY timestamp ASC;');
      const cotizacionesRes = await this.db.query('SELECT delta_id, action, payload_json FROM delta_cotizaciones ORDER BY timestamp ASC;');
      const pedidosRes = await this.db.query('SELECT delta_id, action, payload_json FROM delta_pedidos ORDER BY timestamp ASC;');

      const parseDeltas = (res: any) => res.values ? res.values.map((d: any) => ({
        ...d,
        payload: JSON.parse(d.payload_json)
      })) : [];

      return {
        clientes: parseDeltas(clientesRes),
        cotizaciones: parseDeltas(cotizacionesRes),
        pedidos: parseDeltas(pedidosRes),
      };

    } catch (e) {
      console.error('SQLITE ERROR en getSyncDeltas:', e);
      return { clientes: [], cotizaciones: [], pedidos: [] };
    }
  }

  // Métodos de Captura Delta
  public async insertClienteDelta(clienteData: any): Promise<void> {
    if (!this._isSQLiteActive) return;
    const payload = JSON.stringify(clienteData);
    await this.db.run('INSERT INTO delta_clientes (action, payload_json, timestamp) VALUES (?, ?, ?)', ['INSERT', payload, Date.now()]);
    console.log('SQLITE DELTA: Insertando Cliente en delta_clientes.');
  }

  public async insertCotizacionDelta(cotizacionData: any): Promise<void> {
    if (!this._isSQLiteActive) return;
    const payload = JSON.stringify(cotizacionData);
    await this.db.run('INSERT INTO delta_cotizaciones (action, payload_json, timestamp) VALUES (?, ?, ?)', ['INSERT', payload, Date.now()]);
    console.log('SQLITE DELTA: Insertando Cotización en delta_cotizaciones.');
  }

  public async insertPedidoDelta(action: string, pedidoData: any): Promise<void> {
    if (!this._isSQLiteActive) return;
    const payload = JSON.stringify(pedidoData);
    await this.db.run('INSERT INTO delta_pedidos (action, payload_json, timestamp) VALUES (?, ?, ?)', [action, payload, Date.now()]);
    console.log(`SQLITE DELTA: Registrando acción '${action}' en delta_pedidos.`);
  }

  public async deleteSyncDelta(deltaId: string | number, tableName: string): Promise<void> {
    if (!this._isSQLiteActive) return;

    // El nombre de la tabla DEBE venir del SyncService (delta_clientes, delta_pedidos, etc.)
    await this.db.run(`DELETE FROM ${tableName} WHERE delta_id = ?`, [deltaId]);
    console.log(`SQLITE DELTA: Eliminado delta ID ${deltaId} de la tabla ${tableName}.`);
  }
}