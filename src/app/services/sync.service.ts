// src/app/services/sync.service.ts - CÓDIGO FINAL CORREGIDO

import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { SqliteService } from './sqlite.service';
import { Network } from '@capacitor/network';
import { PedidosService } from './pedidos.service';
import { ClientesService } from './clientes.service';
import { CotizacionService } from './cotizacion.service';

@Injectable({
    providedIn: 'root'
})
export class SyncService {

    private supabaseService = inject(SupabaseService);
    private sqliteService = inject(SqliteService);
    // Aunque no se usan directamente en esta versión final, mantenemos las inyecciones
    // por si los servicios de dominio necesitan ser usados en el futuro.
    private pedidosService = inject(PedidosService);
    private clientesService = inject(ClientesService);
    private cotizacionService = inject(CotizacionService);

    // Bandera para evitar ejecuciones simultáneas de la cola de sync
    private isSyncing = false;

    constructor() {
        // Escuchar cambios de conexión para iniciar la sincronización de Deltas (Sync Up)
        Network.addListener('networkStatusChange', (status) => {
            if (status.connected && !this.isSyncing) {
                console.log("Conexión restaurada. Iniciando Sync Up de Deltas.");
                this.syncUp(); // Usamos el método unificado
            }
        });
    }

    /* -------------------------------------------------------------
       SYNC DOWN: DESCARGA TOTAL (BORRADO Y REINSERCIÓN)
       ------------------------------------------------------------- */

    /**
     * Realiza la descarga completa (Full Sync Down) de todas las tablas
     * desde Supabase hacia la base de datos local (SQLite).
     */
    public async syncAllData(): Promise<void> {
        if (this.isSyncing || !this.sqliteService.isSQLiteActive) {
            console.warn('SYNC: Ya está sincronizando o SQLite no está activo.');
            return;
        }

        const isOnline = await this.supabaseService.isOnline();
        if (!isOnline) {
            console.log("Offline. No se puede realizar el Sync Down.");
            return;
        }

        this.isSyncing = true;
        console.log('SYNC: Iniciando Full Sync Down desde Supabase...');

        try {
            // A. Descarga de Datos de Referencia (Base)
            const unidades = await this.supabaseService.getUnidadesMedida();
            const ingredientes = await this.supabaseService.getIngredientes();
            const estados = await this.supabaseService.getAllEstadosPedidoForSync();

            // B. Descarga de Datos Transaccionales
            const clientes = await this.supabaseService.getAllClientesForSync();
            const cotizaciones = await this.supabaseService.getAllCotizacionesForSync();
            const pedidos = await this.supabaseService.getAllPedidosForSync();

            // C. Guardar en SQLite: Vaciado completo y reinserción
            await this.sqliteService.saveFullSyncDown(
                ingredientes,
                unidades,
                clientes,
                cotizaciones,
                pedidos,
                estados // Todos los argumentos requeridos están presentes
            );

            console.log(`SYNC DOWN exitoso. Clientes: ${clientes.length}, Pedidos: ${pedidos.length}, etc. guardados localmente.`);

        } catch (error) {
            console.error('SYNC ERROR en syncAllData:', error);
            throw new Error('Fallo la sincronización de descarga.');
        } finally {
            this.isSyncing = false;
        }
    }

    /* -------------------------------------------------------------
       SYNC UP: SUBIDA DE DELTAS PENDIENTES
       ------------------------------------------------------------- */

    /**
     * Procesa la cola de Deltas (registros INSERT/UPDATE/DELETE hechos offline)
     * y los envía a Supabase.
     */
    public async syncUp(): Promise<void> {
        if (this.isSyncing || !this.sqliteService.isSQLiteActive) return;

        const isOnline = await this.supabaseService.isOnline();
        if (!isOnline) return;

        this.isSyncing = true;
        console.log('SYNC: Iniciando Sync Up de Deltas locales...');

        try {
            // Asumimos que getSyncDeltas() devuelve el payload ya parseado.
            // Si devuelve JSON string, el JSON.parse es CRÍTICO aquí.
            const deltas = await this.sqliteService.getSyncDeltas();
            // ... (Cálculo de totalDeltas sin cambios) ...

            // 1. Subir Clientes
            for (const delta of deltas.clientes) {
                try {
                    // 🔑 MEJORA: Aseguramos que el payload sea un objeto si viene como string
                    const payloadObj = typeof delta.payload === 'string' ? JSON.parse(delta.payload) : delta.payload;

                    await this.supabaseService.handleClientDelta(delta.action, payloadObj);
                    await this.sqliteService.deleteSyncDelta(delta.delta_id, 'delta_clientes');
                } catch (error) {
                    console.error(`Error al subir cliente Delta ID ${delta.delta_id}. Se reintentará.`, error);
                }
            }

            // 2. Subir Cotizaciones
            for (const delta of deltas.cotizaciones) {
                try {
                    // 🔑 MEJORA: Aseguramos que el payload sea un objeto
                    const payloadObj = typeof delta.payload === 'string' ? JSON.parse(delta.payload) : delta.payload;

                    await this.supabaseService.handleCotizacionDelta(delta.action, payloadObj);
                    await this.sqliteService.deleteSyncDelta(delta.delta_id, 'delta_cotizaciones');
                } catch (error) {
                    console.error(`Error al subir cotización Delta ID ${delta.delta_id}. Se reintentará.`, error);
                }
            }

            // 3. Subir Pedidos
            for (const delta of deltas.pedidos) {
                try {
                    // 🔑 MEJORA: Aseguramos que el payload sea un objeto
                    const payloadObj = typeof delta.payload === 'string' ? JSON.parse(delta.payload) : delta.payload;

                    await this.supabaseService.handlePedidoDelta(delta.action, payloadObj);
                    await this.sqliteService.deleteSyncDelta(delta.delta_id, 'delta_pedidos');
                } catch (error) {
                    console.error(`Error al subir pedido Delta ID ${delta.delta_id}. Se reintentará.`, error);
                }
            }

            console.log('SYNC UP completado y deltas locales procesados.');
        } catch (error) {
            console.error('SYNC ERROR en syncUp:', error);
            throw new Error('Fallo la sincronización de subida.');
        } finally {
            this.isSyncing = false;
        }
    }
}