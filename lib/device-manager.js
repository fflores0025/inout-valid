/**
 * InOut Media - Device Auto-Configuration Library
 * Librería reutilizable para POS, Kioscos y Fichadores
 * Versión: 1.0.0
 */

class InOutDeviceManager {
  constructor(config) {
    this.deviceType = config.deviceType // 'pos', 'kiosk', 'clock'
    this.appVersion = config.appVersion
    this.supabase = config.supabaseClient
    this.deviceId = null
    this.deviceConfig = {}
    this.heartbeatInterval = null
    this.commandsSubscription = null
    this.onConfigLoaded = config.onConfigLoaded || (() => {})
    this.onCommandReceived = config.onCommandReceived || (() => {})
  }

  /**
   * Inicializar el dispositivo
   */
  async initialize() {
    console.log(`[DeviceManager] Inicializando ${this.deviceType}...`)
    
    try {
      // 1. Obtener o generar Device ID
      this.deviceId = await this.getOrCreateDeviceId()
      console.log(`[DeviceManager] Device ID: ${this.deviceId}`)
      
      // 2. Recopilar información del sistema
      const deviceInfo = await this.getDeviceInfo()
      
      // 3. Registrar/actualizar en backend
      const device = await this.registerDevice(deviceInfo)
      
      // 4. Cargar configuración asignada
      if (device) {
        this.deviceConfig = device.config || {}
        await this.onConfigLoaded(device)
      }
      
      // 5. Iniciar heartbeat
      this.startHeartbeat()
      
      // 6. Escuchar comandos remotos
      this.subscribeToCommands()
      
      // 7. Logging inicial
      await this.log('info', 'Dispositivo inicializado correctamente', { version: this.appVersion })
      
      console.log(`[DeviceManager] ✅ Inicialización completada`)
      return device
      
    } catch (error) {
      console.error(`[DeviceManager] ❌ Error en inicialización:`, error)
      await this.log('error', 'Error en inicialización', { error: error.message })
      throw error
    }
  }

  /**
   * Generar o recuperar Device ID único
   */
  async getOrCreateDeviceId() {
    let deviceId = localStorage.getItem('INOUT_DEVICE_ID')
    
    if (!deviceId) {
      // Generar ID único basado en tipo + timestamp + random
      const timestamp = Date.now()
      const random = Math.random().toString(36).substr(2, 9).toUpperCase()
      deviceId = `${this.deviceType.toUpperCase()}-${timestamp}-${random}`
      
      localStorage.setItem('INOUT_DEVICE_ID', deviceId)
      console.log(`[DeviceManager] Nuevo Device ID generado: ${deviceId}`)
    }
    
    return deviceId
  }

  /**
   * Recopilar información del sistema
   */
  async getDeviceInfo() {
    const info = {
      device_id: this.deviceId,
      device_type: this.deviceType,
      version: this.appVersion,
      os_info: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        screen: `${screen.width}x${screen.height}`,
        cores: navigator.hardwareConcurrency || 'unknown',
        memory: navigator.deviceMemory ? `${navigator.deviceMemory}GB` : 'unknown'
      },
      ip_address: await this.getPublicIP()
    }
    
    return info
  }

  /**
   * Obtener IP pública
   */
  async getPublicIP() {
    try {
      const response = await fetch('https://api.ipify.org?format=json', { timeout: 5000 })
      const data = await response.json()
      return data.ip
    } catch (error) {
      console.warn('[DeviceManager] No se pudo obtener IP pública:', error)
      return 'unknown'
    }
  }

  /**
   * Registrar o actualizar dispositivo en Supabase
   */
  async registerDevice(deviceInfo) {
    try {
      const { data, error } = await this.supabase
        .from('devices')
        .upsert({
          ...deviceInfo,
          status: 'online',
          last_heartbeat: new Date().toISOString()
        }, { 
          onConflict: 'device_id',
          ignoreDuplicates: false 
        })
        .select()
        .single()
      
      if (error) throw error
      
      console.log('[DeviceManager] Dispositivo registrado:', data)
      return data
      
    } catch (error) {
      console.error('[DeviceManager] Error al registrar dispositivo:', error)
      throw error
    }
  }

  /**
   * Iniciar heartbeat periódico (cada 30s)
   */
  startHeartbeat() {
    console.log('[DeviceManager] Iniciando heartbeat cada 30s...')
    
    // Enviar heartbeat inmediato
    this.sendHeartbeat()
    
    // Programar heartbeats regulares
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat()
    }, 30000) // 30 segundos
  }

  /**
   * Enviar heartbeat a Supabase
   */
  async sendHeartbeat() {
    try {
      // Recopilar métricas actuales
      const metrics = await this.collectMetrics()
      
      // Insertar heartbeat
      await this.supabase.from('device_heartbeats').insert({
        device_id: this.deviceId,
        status: 'online',
        metrics
      })
      
      // Actualizar last_heartbeat en devices
      await this.supabase.from('devices')
        .update({ 
          last_heartbeat: new Date().toISOString(),
          status: 'online'
        })
        .eq('device_id', this.deviceId)
      
      console.log(`[DeviceManager] ❤️ Heartbeat enviado`)
      
    } catch (error) {
      console.error('[DeviceManager] Error al enviar heartbeat:', error)
      // No lanzar error - siguiente heartbeat lo intentará de nuevo
    }
  }

  /**
   * Recopilar métricas del dispositivo
   */
  async collectMetrics() {
    const metrics = {
      timestamp: new Date().toISOString()
    }
    
    // Batería (si está disponible)
    if (navigator.getBattery) {
      try {
        const battery = await navigator.getBattery()
        metrics.battery = Math.round(battery.level * 100)
        metrics.charging = battery.charging
      } catch (e) {}
    }
    
    // Conexión
    if (navigator.connection) {
      metrics.connection = {
        type: navigator.connection.effectiveType,
        downlink: navigator.connection.downlink,
        rtt: navigator.connection.rtt
      }
    }
    
    // Almacenamiento (aproximado)
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate()
        metrics.storage = {
          used: Math.round(estimate.usage / 1024 / 1024), // MB
          quota: Math.round(estimate.quota / 1024 / 1024), // MB
          percent: Math.round((estimate.usage / estimate.quota) * 100)
        }
      } catch (e) {}
    }
    
    // Métricas específicas por tipo de dispositivo
    if (this.deviceType === 'pos') {
      metrics.cached_balance = this.getCachedBalance()
      metrics.pending_syncs = this.getPendingSyncsCount()
    }
    
    if (this.deviceType === 'kiosk') {
      metrics.last_transaction_time = localStorage.getItem('last_transaction_time')
      metrics.transactions_today = this.getTransactionsToday()
    }
    
    return metrics
  }

  /**
   * Métricas específicas de POS
   */
  getCachedBalance() {
    try {
      // Implementar según lógica de inout-valid
      return parseFloat(localStorage.getItem('cached_total_balance') || '0')
    } catch {
      return 0
    }
  }

  getPendingSyncsCount() {
    try {
      const queue = JSON.parse(localStorage.getItem('sync_queue') || '[]')
      return queue.length
    } catch {
      return 0
    }
  }

  /**
   * Métricas específicas de Kiosco
   */
  getTransactionsToday() {
    try {
      const today = new Date().toISOString().split('T')[0]
      const transactions = JSON.parse(localStorage.getItem('transactions') || '[]')
      return transactions.filter(t => t.date?.startsWith(today)).length
    } catch {
      return 0
    }
  }

  /**
   * Suscribirse a comandos remotos via Realtime
   */
  subscribeToCommands() {
    console.log('[DeviceManager] Escuchando comandos remotos...')
    
    this.commandsSubscription = this.supabase
      .channel(`device-commands-${this.deviceId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'device_commands',
        filter: `device_id=eq.${this.deviceId}`
      }, async (payload) => {
        const cmd = payload.new
        
        // Solo procesar comandos pendientes
        if (cmd.status !== 'pending') return
        
        console.log(`[DeviceManager] 📥 Comando recibido: ${cmd.command}`, cmd.params)
        
        // Marcar como "ejecutando"
        await this.updateCommandStatus(cmd.id, 'executing')
        
        // Ejecutar comando
        try {
          const result = await this.executeCommand(cmd)
          
          // Marcar como ejecutado
          await this.updateCommandStatus(cmd.id, 'executed', result)
          
          await this.log('info', `Comando ejecutado: ${cmd.command}`, { result })
          
        } catch (error) {
          // Marcar como fallido
          await this.updateCommandStatus(cmd.id, 'failed', { error: error.message })
          
          await this.log('error', `Error al ejecutar comando: ${cmd.command}`, { error: error.message })
        }
      })
      .subscribe()
  }

  /**
   * Ejecutar comando remoto
   */
  async executeCommand(cmd) {
    const handlers = {
      reboot: async () => {
        await this.log('info', 'Reiniciando dispositivo...')
        setTimeout(() => location.reload(), 1000)
        return { message: 'Reiniciando en 1 segundo...' }
      },
      
      update: async (params) => {
        await this.log('info', 'Actualizando aplicación...', params)
        // Limpiar caché
        if ('caches' in window) {
          const cacheNames = await caches.keys()
          await Promise.all(cacheNames.map(name => caches.delete(name)))
        }
        setTimeout(() => location.reload(true), 1000)
        return { message: 'Caché limpiada, recargando...' }
      },
      
      clear_cache: async () => {
        // Limpiar localStorage (excepto DEVICE_ID)
        const deviceId = localStorage.getItem('INOUT_DEVICE_ID')
        localStorage.clear()
        localStorage.setItem('INOUT_DEVICE_ID', deviceId)
        
        // Limpiar caché del navegador
        if ('caches' in window) {
          const cacheNames = await caches.keys()
          await Promise.all(cacheNames.map(name => caches.delete(name)))
        }
        
        return { message: 'Caché limpiada exitosamente' }
      },
      
      shutdown: async () => {
        await this.log('warning', 'Apagando dispositivo...')
        // En Linux con permisos: ejecutar shutdown vía script
        // Por ahora solo cerrar ventana/app
        window.close()
        return { message: 'Intentando apagar...' }
      },
      
      change_event: async (params) => {
        if (!params.event_id) throw new Error('event_id requerido')
        
        // Guardar nuevo evento
        localStorage.setItem('selected_event_id', params.event_id)
        
        // Recargar para aplicar cambios
        setTimeout(() => location.reload(), 1000)
        
        return { message: `Evento cambiado a ${params.event_id}` }
      },
      
      sync_now: async () => {
        // Forzar sincronización inmediata
        if (typeof window.forceSyncNow === 'function') {
          await window.forceSyncNow()
          return { message: 'Sincronización completada' }
        }
        return { message: 'Sincronización no disponible' }
      }
    }
    
    const handler = handlers[cmd.command]
    if (!handler) {
      throw new Error(`Comando desconocido: ${cmd.command}`)
    }
    
    // Ejecutar handler
    const result = await handler(cmd.params)
    
    // Llamar callback personalizado
    if (this.onCommandReceived) {
      await this.onCommandReceived(cmd, result)
    }
    
    return result
  }

  /**
   * Actualizar estado de un comando
   */
  async updateCommandStatus(commandId, status, result = {}) {
    try {
      const update = {
        status,
        result
      }
      
      if (status === 'executed' || status === 'failed') {
        update.executed_at = new Date().toISOString()
      }
      
      await this.supabase
        .from('device_commands')
        .update(update)
        .eq('id', commandId)
      
    } catch (error) {
      console.error('[DeviceManager] Error al actualizar comando:', error)
    }
  }

  /**
   * Enviar log al backend
   */
  async log(level, message, details = {}) {
    try {
      await this.supabase.from('device_logs').insert({
        device_id: this.deviceId,
        level,
        message,
        details
      })
      
      // También log en consola
      const logFn = level === 'error' ? console.error : console.log
      logFn(`[${level.toUpperCase()}] ${message}`, details)
      
    } catch (error) {
      console.error('[DeviceManager] Error al enviar log:', error)
    }
  }

  /**
   * Actualizar configuración local
   */
  async updateConfig(newConfig) {
    this.deviceConfig = { ...this.deviceConfig, ...newConfig }
    
    // Guardar en Supabase
    await this.supabase
      .from('devices')
      .update({ config: this.deviceConfig })
      .eq('device_id', this.deviceId)
    
    await this.log('info', 'Configuración actualizada', newConfig)
  }

  /**
   * Obtener configuración actual
   */
  getConfig(key = null) {
    if (key) {
      return this.deviceConfig[key]
    }
    return this.deviceConfig
  }

  /**
   * Destruir instancia (cleanup)
   */
  destroy() {
    console.log('[DeviceManager] Limpiando recursos...')
    
    // Detener heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    
    // Cancelar suscripción a comandos
    if (this.commandsSubscription) {
      this.commandsSubscription.unsubscribe()
      this.commandsSubscription = null
    }
  }
}

// Export para uso en módulos
if (typeof module !== 'undefined' && module.exports) {
  module.exports = InOutDeviceManager
}
