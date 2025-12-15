import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { createClient, SupabaseClient, Session, SupportedStorage } from '@supabase/supabase-js';
import { SqliteService } from './sqlite.service';
import { SyncService } from './sync.service';

import { CotizacionDetalleExtendida} from "../models/database.types";
import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';

const CapacitorStorage: SupportedStorage = {
    // Supabase llama a getItem(key)
    getItem: async (key: string): Promise<string | null> => {
        const result = await Preferences.get({ key });
        // Preferences.get devuelve { value: string | null }
        return result.value;
    },
    // Supabase llama a setItem(key, value)
    setItem: async (key: string, value: string): Promise<void> => {
        // Preferences.set espera un objeto { key, value }
        await Preferences.set({ key, value });
    },
    // Supabase llama a removeItem(key)
    removeItem: async (key: string): Promise<void> => {
        // Preferences.remove espera un objeto { key }
        await Preferences.remove({ key });
    },
};

const supabaseUrl = 'https://ymdcsjmzmagjyudfijtz.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InltZGNzam16bWFnanl1ZGZpanR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM2ODQzMjAsImV4cCI6MjA3OTI2MDMyMH0.KzFLfbkzWcVt3HjMoSgXfA6Lemh-UmKLuPFMd8rNXok';

import {
    Ingrediente,
    UserRole,
    UnidadMedida,
    Cotizacion,
    CotizacionData,
    CotizacionInsert,
    CotizacionDetalleInsert, // Importamos todos los tipos nuevos
    ClienteInsert
} from '../models/database.types';

@Injectable({
  providedIn: 'root'
})

export class SupabaseService {

    private supabase: SupabaseClient;
    private router = inject(Router);
    public sqliteService = inject(SqliteService);

    constructor() {
        // CORRECCIÓN CRÍTICA DE ESTABILIDAD: Evitar conflicto de LockManager en Capacitor
        this.supabase = createClient(supabaseUrl, supabaseKey, {
            auth: {
                // 🔑 USAMOS EL ADAPTADOR EN LUGAR DEL OBJETO PREFERENCES DIRECTO
                storage: CapacitorStorage,
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: false,
            },
        });
    }

    /** Verifica si hay conexión a internet */
    public async isOnline(): Promise<boolean> {
        const status = await Network.getStatus();
        return status.connected;
    }

    /** Obtiene la sesión actual de Supabase */
    public async getSession(): Promise<Session | null> {
        const isConnected = await this.isOnline();

        try {
            // 1. Intentar validar la sesión online con Supabase
            const {data: {session}} = await this.supabase.auth.getSession();

            // Si hay una sesión activa Y el token es válido, retornarla.
            if (session) {
                return session;
            }
        } catch (e) {
            // La llamada a la API falló (posiblemente desconectado)
            console.warn('Error al verificar sesión en línea (posiblemente desconectado).', e);
        }

        // 2. 🔑 Verificación de Respaldo: Si la conexión falló o no la hay
        if (!isConnected) {
            // Delegamos la verificación de la existencia de la caché al SqliteService
            // 🚨 ASUMO que SqliteService tiene un método que verifica si existe cualquier sesión guardada.
            // Usaremos un método que retorne solo `true` o `false`.

            const isAuthenticatedLocally = await this.sqliteService.hasLocalAuthEntry(); // -- Este es el método delegado

            if (isAuthenticatedLocally) {
                console.log('Sesión validada OFFLINE vía caché local. Permitiendo navegación.');

                // Devolvemos un objeto Session simulado para que el AuthGuard no redirija al /login.
                return { user: { id: 'local-user', email: 'local@local.com' } } as Session;
            }
        }

        // Si la sesión Supabase es nula Y no hay caché local o hay conexión pero el token expiró.
        return null;
    }

    /** LOGIN ONLINE */
    public async signIn(email: string, password: string): Promise<any> { // Puede devolver el user object o un simple flag
        const {data, error} = await this.supabase.auth.signInWithPassword({email, password});
        if (error) throw error;

        // 1. Guardar email local en SQLite (Esto sigue siendo tarea de SupabaseService)
        if (data.user?.email) {
            try {
                // Asegúrese de que sqliteService.setLocalAuth exista
                await this.sqliteService.setLocalAuth(data.user.email);
            } catch (e) {
                console.error('Error SQLite:', e);
                // No bloqueamos el login por un error local de caché
            }
        }

        // 2. 🔑 Eliminamos la llamada a this.syncService.syncAllData();

        return data.user; // Retornamos los datos del usuario para que el componente lo use
    }

    /** LOGIN OFFLINE */
    public async localSignIn(email: string): Promise<boolean> {
        return this.sqliteService.checkLocalAuth(email);
    }

    /** Cierre de sesión y navega a la página de login */
    public async signOut(): Promise<void> {
        try {
            await this.supabase.auth.signOut();

            // Usamos replaceUrl: true para que el usuario no pueda volver con el botón "atrás" del navegador.
            this.router.navigate(['/login'], {replaceUrl: true});

        } catch (e) {
            console.warn('No se pudo cerrar sesión:', e);
        }
    }

    /**
     * Obtiene el listado de Ingredientes según el rol del usuario.
     * - Administrador: Ve activos y eliminados (is_deleted: true o false).
     * - Simple: Solo ve activos (is_deleted: false).
     * @returns Promesa que resuelve un array de Ingrediente.
     */
    public async getIngredientes(searchText?: string): Promise<Ingrediente[]> {
        const session = await this.getSession(); // Asumo que tienes este método
        if (!session) {
            throw new Error('No hay sesión activa para realizar la consulta.');
        }

        const userRole = await this.getUserRole(); // Asumo que tienes este método

        let query = this.supabase
            .from('ingredientes')
            .select('*, unidad_medida(unmed_nombre)');

        // 1. FILTRADO POR BÚSQUEDA (ilike)
        if (searchText && searchText.trim() !== '') {
            // Busca coincidencias parciales en el nombre, insensible a mayúsculas/minúsculas
            query = query.ilike('ing_nombre', `%${searchText}%`);
        }

        // 2. Aplicar filtro de Soft Delete basado en el rol
        if (userRole === 'user') {
            // ROL SIMPLE: Solo ve los activos
            query = query.eq('is_deleted', false);
        }

        // 3. Ordenamiento
        query = query.order('ing_nombre', {ascending: true});

        const {data, error} = await query;

        if (error) {
            console.error('Error en getIngredientes:', error);
            throw error;
        }

        // Asegúrate de que este mapeo sea consistente con cómo vienen tus datos.
        const mappedData = data.map((item: any) => ({

            ing_id: item.ing_id,
            ing_nombre: item.ing_nombre,
            ing_precio: item.ing_precio,
            ing_cantidad_base: item.ing_cantidad_base,
            is_deleted: item.is_deleted,
            unmed_id: item.unmed_id,

            // El objeto de JOIN (Propiedad que usas en la interfaz Ingrediente)
            unidad_medida: item.unidad_medida || null,

            // 🔑 CORRECCIÓN CRÍTICA: Asignar la propiedad PLANA 'unmed_nombre'
            // La unidad de medida viene como un objeto anidado por el JOIN 1:1.
            // Accedemos a la propiedad 'unmed_nombre' dentro del objeto 'unidad_medida'.
            unmed_nombre: item.unidad_medida?.unmed_nombre || 'N/A',

        }));

        return mappedData as Ingrediente[];
    }

    /**
     * Obtiene el rol del usuario actual desde la tabla 'profiles'.
     * @returns El rol del usuario ('administrador' o 'simple'), por defecto 'simple'.
     */
    public async getUserRole(): Promise<'administrador' | 'user'> {
        const session = await this.getSession();
        if (!session) {
            return 'user';
        }

        try {
            const {data, error} = await this.supabase
                .from('profiles')
                .select('role')
                .eq('id', session.user.id)
                .single();

            if (error) {
                console.error("Error al obtener el rol del perfil:", error.message);
                // Si hay un error de consulta (ej. perfil no encontrado), asignamos el rol más restrictivo.
                return 'user';
            }

            // Esto asegura que " Administrador " se trate como "administrador".
            const role = data.role?.toLowerCase().trim();

            if (role === 'administrador') {
                return 'administrador';
            }

            // Cualquier otro valor (incluyendo 'user', 'null', o cualquier otra cosa)
            return 'user';

        } catch (e) {
            console.error("Excepción en getUserRole:", e);
            return 'user';
        }
    }

    /**
     * Realiza la Eliminación Suave (Soft Delete) o Restauración de un ingrediente.
     * El usuario debe tener rol 'administrador' para que el RLS lo permita.
     * @param id El ing_id del ingrediente.
     * @param isDeleted El nuevo estado: true para eliminar, false para restaurar.
     */
    public async softDeleteIngrediente(id: string, isDeleted: boolean): Promise<void> {
        const {error} = await this.supabase
            .from('ingredientes')
            .update({is_deleted: isDeleted}) // Cambia el estado
            .eq('ing_id', id); // Donde el ID coincide

        if (error) throw error;
    }

    /**
     * Obtiene las unidades de medida disponibles para el formulario.
     * La columna unmed_id es de tipo INT4, por eso usamos number.
     * @returns Promesa que resuelve una lista de objetos UnidadMedida.
     */
    public async getUnidadesMedida(): Promise<UnidadMedida[]> {
        const {data, error} = await this.supabase
            .from('unidad_medida') //Asegura que el nombre de la tabla sea este
            .select('unmed_id, unmed_nombre') // Columnas necesarias
            .order('unmed_nombre', {ascending: true});

        if (error) {
            console.error("Error al obtener unidades de medida:", error.message);
            throw new Error('Error al cargar las unidades de medida.');
        }

        // Usamos el casting para asegurar que el ID es tratado como number.
        return data as UnidadMedida[];
    }

    /**
     * Obtiene los detalles de un ingrediente específico para edición.
     * Realiza un JOIN implícito para obtener el nombre de la unidad de medida.
     */
    // En src/app/services/supabase.service.ts, dentro de la clase SupabaseService:

    public async getIngredienteById(id: string): Promise<Ingrediente> {
        const {data, error} = await this.supabase
            .from('ingredientes')
            .select(`
          ing_id,
          ing_nombre,
          ing_precio,
          unmed_id,
          is_deleted,
          ing_cantidad_base,
          unidad_medida (unmed_nombre)`) // ing_estado ha sido eliminado del select
            .eq('ing_id', id)
            .limit(1)
            .single();

        if (error) {
            console.error("Error al obtener ingrediente:", error.message);
            throw new Error('No se pudo cargar el ingrediente.');
        }

        if (!data) {
            throw new Error(`Ingrediente con ID ${id} no encontrado.`);
        }

        // Cuando se usa .single(), el JOIN 1:1 devuelve un OBJETO.
        const unidadMedidaObjeto = data.unidad_medida as unknown as { unmed_nombre: string } | null;

        // Extracción simple
        const nombreUnidad = unidadMedidaObjeto
            ? unidadMedidaObjeto.unmed_nombre
            : 'N/A';


        const ingrediente: Ingrediente = {
            ing_id: data.ing_id,
            ing_nombre: data.ing_nombre,
            ing_precio: data.ing_precio,
            is_deleted: data.is_deleted,
            ing_cantidad_base: data.ing_cantidad_base,

            unmed_nombre: nombreUnidad,
            unidad_medida: unidadMedidaObjeto,

            unmed_id: data.unmed_id, // Asumimos que es number
        };

        return ingrediente;
    }

    /**
     * Agrega un nuevo ingrediente a la base de datos.
     * Excluye propiedades que no son parte de la tabla 'ingredientes'.
     */
    public async addIngrediente(data: Partial<Ingrediente>): Promise<void> {
        // Usamos la desestructuración para excluir 'unmed_nombre' (solo está en la interfaz)
        const {unmed_nombre, ...ingredienteData} = data;

        const {error} = await this.supabase
            .from('ingredientes')
            .insert([ingredienteData]); // Insertamos solo los campos de la tabla

        if (error) {
            console.error("Error al agregar ingrediente:", error.message);
            throw new Error('Error al agregar el ingrediente. Verifique políticas RLS de INSERT.');
        }
    }

    /**
     * Actualiza los datos de un ingrediente existente.
     */
    public async updateIngrediente(id: string, data: Partial<Ingrediente>): Promise<void> {
        // Excluimos 'unmed_nombre' antes de actualizar
        const {unmed_nombre, ...ingredienteData} = data;

        const {error} = await this.supabase
            .from('ingredientes')
            .update(ingredienteData)
            .eq('ing_id', id);

        if (error) {
            console.error("Error al actualizar ingrediente:", error.message);
            throw new Error('Error al actualizar el ingrediente. Verifique políticas RLS de UPDATE.');
        }
    }


    //*****************************************************************
    //Métodos cótización
    public async createCotizacion(data: CotizacionData) {

        // 1. SEPARAR CABECERA Y DETALLE
        const { detalles, ...cotizacionCabecera } = data; // cotizacionCabecera ya tiene cot_total y cot_nombre

        // 2. INSERTAR LA CABECERA EN 'cotizacion'
        const { data: cotizacionData, error: cotizacionError } = await this.supabase
            .from('cotizacion')
            // El casting es para asegurar que TS sabe que enviamos CotizacionInsert
            .insert(cotizacionCabecera as CotizacionInsert)
            .select('cot_id') // Necesitamos el ID generado
            .single();

        if (cotizacionError) {
            console.error('Error al crear cabecera de cotización:', cotizacionError);
            return { data: null, error: cotizacionError };
        }

        const newCotId = (cotizacionData as Cotizacion).cot_id;

        if (detalles && detalles.length > 0 && newCotId) {

            // 3. PREPARAR DATOS PARA 'cotizacion_detalle'
            // Mapeamos los detalles para incluir el cot_id recién generado
            const detallesToInsert = detalles.map(d => ({
                cot_id: newCotId,
                ing_id: d.ing_id,
                cantidad_usada: d.cantidad_usada,
                precio_unitario_fijo: d.precio_unitario_fijo,
            }));

            // 4. INSERTAR EL DETALLE EN 'cotizacion_detalle'
            const { error: detalleError } = await this.supabase
                .from('cotizacion_detalle')
                .insert(detallesToInsert);

            if (detalleError) {
                console.error('Error al insertar detalles de cotización:', detalleError);
                // 🚨 CONSEJO: Aquí podrías añadir una lógica para ELIMINAR la cabecera
                // recién creada si el detalle falla, para evitar filas huérfanas (rollback manual).
                return { data: null, error: detalleError };
            }
        }

        // Retorna la cotización completa con el ID recién generado
        return { data: { ...data, cot_id: newCotId }, error: null };
    }

    public async convertirAPedido(data: {
        nombre: string;
        apellido: string;
        instagram: string;
        telefono: string;
        fechaEntrega: string;
        precio: number;
        cotId: string; // 🔑 CORRECCIÓN: Asumimos que cotId es UUID (string)
    }) {
        let cli_id: string;

        // 1. GESTIÓN DEL CLIENTE: INSERCIÓN DIRECTA (Sin cambios)
        const clientInfo = {
            cli_nombre: data.nombre,
            cli_apellido: data.apellido,
            cli_instagram: data.instagram,
            cli_telefono: data.telefono,
        };

        const { data: newClient, error: createError } = await this.supabase
            .from('cliente')
            // @ts-ignore
            .insert(clientInfo)
            .select('cli_id')
            .single();

        if (createError || !newClient) {
            console.error('Error al insertar cliente:', createError);
            return { data: null, error: { message: "Error al crear cliente. Revisar RLS o campos requeridos." } };
        }

        cli_id = (newClient as any).cli_id;

        // 2. 🔑 GESTIÓN DEL ESTADO INICIAL (NUEVO PASO)

        // A. Consultar el ID del estado 'PENDIENTE'
        const { data: estadoData, error: estadoError } = await this.supabase
            .from('estado_pedido')
            .select('est_id')
            .eq('est_nombre', 'PENDIENTE') // 🔑 Buscar el estado por defecto
            .single();

        if (estadoError || !estadoData) {
            console.error('Error: No se encontró el ID del estado PENDIENTE.', estadoError);
            return { data: null, error: { message: "Error: El estado inicial (PENDIENTE) no está configurado en la base de datos." } };
        }

        const estadoInicialId = (estadoData as any).est_id; // UUID del estado

        // 3. CREAR EL PEDIDO
        const { data: newOrder, error: orderError } = await this.supabase
            .from('pedido')
            // @ts-ignore
            .insert({
                cli_id: cli_id,
                cot_id: data.cotId,
                ped_fecha_entrega: data.fechaEntrega,
                ped_precio: data.precio,
                est_id: estadoInicialId // 🔑 CAMBIO CLAVE: Usamos el UUID del estado
                // Se elimina la línea 'ped_estado: 'CONFIRMADO''
            })
            .select()
            .single();

        if (orderError) {
            console.error('Error al crear pedido:', orderError);
            return { data: null, error: { message: "Error al crear pedido. Revisar RLS de tabla 'pedido'." } };
        }

        // Éxito
        return { data: newOrder, error: null };
    }

    // 1. Método para obtener clientes (usado por el modal)
    async getClientes() {
        const {data, error} = await this.supabase
            .from('cliente')
            .select('cli_id, cli_nombre, cli_apellido, cli_telefono, cli_instragram')
            //.is('deleted_at', null)
            .order('cli_nombre', {ascending: true});

        if (error) {
            console.error('Error fetching clientes:', error);
            return {data: [], error};
        }
        return {data, error};
    }

// 2. Método para crear un cliente (usado por el modal)
  async createCliente(cliente: any) { // Usamos 'any' si no tienes la interfaz DB['Tables']['cliente']['Insert']
    const { data, error } = await this.supabase
      .from('cliente')
      .insert(cliente)
      .select()
      .single();

    return { data, error };
  }

// *****************************************************************
// Métodos para la Gestión de Clientes (CRUD con Soft Delete)
// *****************************************************************

    /**
     * Crea un cliente o lo actualiza (Upsert) basado en el email (asumiendo que es UNIQUE).
     * Retorna el cliente insertado/actualizado.
     */
    public async saveCliente(clienteData: any) {
        const { data, error } = await this.supabase
            .from('cliente')
            .upsert(clienteData) // Usa upsert si quieres evitar duplicados por email
            .select('*')
            .single();

        return { data, error };
    }

    /**
     * Busca clientes por nombre o email que no estén eliminados.
     */
    public async searchClientes(searchTerm: string) {
        const { data, error } = await this.supabase
            .from('cliente')
            .select('*')
            .is('deleted_at', null)
            .or(`nombre.ilike.%${searchTerm}%,email.ilike.%${searchTerm}%`)
            .order('nombre', { ascending: true });

        return { data, error };
    }

    /**
     * Realiza el Soft Delete: actualiza la columna 'deleted_at' con la fecha actual.
     */
    public async softDeleteCliente(cliId: string) {
        const { data, error } = await this.supabase
            .from('cliente')
            .update({ deleted_at: new Date().toISOString() }) // Marca con fecha/hora actual
            .eq('cli_id', cliId);

        return { data, error };
    }

    public get supabaseClient(): SupabaseClient {
        return this.supabase;
    }

    /** * Obtiene los detalles de cotización para un cotId dado y mapea la respuesta
     * para que coincida con la estructura aplanada de CotizacionDetalleExtendida.
     */
    public async getCotizacionDetailsByCotId(cotId: string | number): Promise<CotizacionDetalleExtendida[]> {

        // Uso la sintaxis estándar de Supabase para obtener el JOIN anidado.
        const { data, error } = await this.supabase
            .from('cotizacion_detalle')
            .select(`
        cantidad_usada,
        precio_unitario_fijo,
        ingredientes ( ing_nombre, unidad_medida ( unmed_nombre ) ) 
    `)
            .eq('cot_id', cotId);

        if (error) {
            console.error("Error al obtener detalles de cotización:", error);
            throw error;
        }

        // Si data está vacío o nulo, retorno un array vacío.
        if (!data || data.length === 0) {
            return [];
        }

        // 2. Mapear la estructura de datos (SIMPLIFICACIÓN)
        const mappedData: CotizacionDetalleExtendida[] = data.map((detail: any) => {

            // Asumo que 'ingredientes' viene como un OBJETO, no un array (comportamiento estándar de N:1 en Supabase)
            const ingredienteCrudo = detail.ingredientes;

            let ingredienteAdaptado: CotizacionDetalleExtendida['ingredientes'] = null;

            if (ingredienteCrudo) {
                // Asumo que 'unidad_medida' viene como un OBJETO singular, no un array.
                const unidadMedidaAdaptada = ingredienteCrudo.unidad_medida;

                ingredienteAdaptado = {
                    ing_nombre: ingredienteCrudo.ing_nombre,
                    // Si unidad_medida viene como objeto, lo asigno directamente.
                    unidad_medida: unidadMedidaAdaptada
                };
            }

            // Devuelvo el objeto final, tipado a CotizacionDetalleExtendida
            return {
                cantidad_usada: detail.cantidad_usada,
                // price_unitario_fijo es opcional, pero lo incluyo si existe en la consulta
                precio_unitario_fijo: detail.precio_unitario_fijo,
                ingredientes: ingredienteAdaptado
            } as CotizacionDetalleExtendida;
        });

        return mappedData;
    }

    public async getAllClientesForSync(): Promise<any[]> {
        const { data, error } = await this.supabase
            .from('cliente')
            .select('*')
            .order('cli_nombre', { ascending: true });

        if (error) {
            console.error('Error Sync Down clientes:', error);
            throw error;
        }
        return data || [];
    }

    public async getAllCotizacionesForSync(): Promise<any[]> {
        const { data, error } = await this.supabase
            .from('cotizacion')
            .select(`
                *,
                cotizacion_detalle (*)
            `)
            .order('cot_fecha', { ascending: false });

        if (error) {
            console.error('Error Sync Down cotizaciones:', error);
            throw error;
        }
        return data || [];
    }

    public async getAllPedidosForSync(): Promise<any[]> {
        const { data, error } = await this.supabase
            .from('pedido')
            .select(`
                *,
                estado_pedido(est_nombre),
                cliente!inner(cli_nombre, cli_apellido)
            `)
            .order('ped_fecha_entrega', { ascending: false });

        if (error) {
            console.error('Error Sync Down pedidos:', error);
            throw error;
        }
        return data || [];
    }

    public async getAllEstadosPedidoForSync(): Promise<any[]> {
        console.log('SUPABASE: Obteniendo todos los estados de pedido...');
        const { data, error } = await this.supabase
            .from('estado_pedido')
            .select('*');

        if (error) {
            console.error('Error al obtener estados de pedido:', error);
            throw error;
        }
        return data || [];
    }

    public async handleClientDelta(action: string, clientPayload: any): Promise<void> {
        console.log(`SUPABASE: Procesando Delta Cliente: ${action}`);
        const table = 'cliente';

        if (action === 'INSERT' || action === 'UPDATE') {
            const { error } = await this.supabase
                .from(table)
                // Usa upsert para insertar si no existe, o actualizar si existe (basado en cli_id)
                .upsert(clientPayload)
                .select();

            if (error) throw error;

        } else if (action === 'DELETE') {
            // Soft Delete: marcamos 'deleted_at'
            const { error } = await this.supabase
                .from(table)
                .update({ deleted_at: new Date().toISOString() })
                .eq('cli_id', clientPayload.cli_id); // Usa el ID del payload

            if (error) throw error;
        }
    }

    public async handleCotizacionDelta(action: string, cotizacionPayload: any): Promise<void> {
        console.log(`SUPABASE: Procesando Delta Cotización: ${action}`);

        // 1. Separamos el array de detalles del resto del payload.
        // Usamos 'cotizacion_detalle' que es el nombre de la tabla de Supabase.
        // El resto de las propiedades quedan en 'cabecera' (cot_id, cot_nombre, cot_total, cot_fecha).
        const { cotizacion_detalle, ...cabecera } = cotizacionPayload;

        // 2. Upsert/Update de la Cabecera (SÓLO campos de cotizacion)
        const { error: cabeceraError } = await this.supabase
            .from('cotizacion')
            .upsert(cabecera); // Upsert basado en cot_id

        if (cabeceraError) throw cabeceraError;

        // 3. Upsert de los Detalles (SÓLO si existen)
        if (cotizacion_detalle && cotizacion_detalle.length > 0) {
            // Los detalles deben tener ya el cot_id para hacer el upsert
            const { error: detalleError } = await this.supabase
                .from('cotizacion_detalle')
                .upsert(cotizacion_detalle, { onConflict: 'cot_id, ing_id' });

            if (detalleError) throw detalleError;
        }
    }

    public async handlePedidoDelta(action: string, pedidoPayload: any): Promise<void> {
        console.log(`SUPABASE: Procesando Delta Pedido: ${action}`);

        if (action === 'INSERT' || action === 'UPDATE') {
            const { error } = await this.supabase
                .from('pedido')
                .upsert(pedidoPayload); // Upsert basado en ped_id

            if (error) throw error;
        }
    }

}
