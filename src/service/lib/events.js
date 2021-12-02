const os = require('os')
// const throttle = require('lodash.throttle')

const {
  PORT,
  LOG_DIR,
  BROADCAST_EVENT: broadcastEvent
} = global

const UNKNOWN_VALUE = 'Unknown'

const EliteJson = require('./elite-json')
const EliteLog = require('./elite-log')
const EDSM = require('./edsm')
const SystemMap = require('./system-map')

// Instances that can be used to query game state
const eliteJson = new EliteJson(LOG_DIR)
const eliteLog = new EliteLog(LOG_DIR)

// TODO Define these in another file / merge with eventHandlers before porting
// over existing event handlers from the internal build
const ICARUS_EVENTS = {
  IcarusGameLoadedEvent: {
    events: ['LoadGame'],
    handler: async () => { /* Return JSON */ }
  }
}

const GAME_EVENT_TO_ICARUS_EVENT_MAP = {}

// Create mapping of game events to ICARUS events, so that when a game event
// happens it's easy to lookup what ICARUS events to fire
Object.keys(ICARUS_EVENTS).forEach(icarusEventName => {
  ICARUS_EVENTS[icarusEventName].events.forEach(gameEventName => {
    if (!GAME_EVENT_TO_ICARUS_EVENT_MAP[gameEventName]) GAME_EVENT_TO_ICARUS_EVENT_MAP[gameEventName] = []
    GAME_EVENT_TO_ICARUS_EVENT_MAP[gameEventName].push(icarusEventName)
  })
})

// Track initial file load
let loadingComplete = false
let loadingInProgress = false
let numberOfEventsImported = 0 // Count of log entries loaded
let numberOfLogLines = 0
let logSizeInBytes = 0 //
const filesLoaded = [] // List of files loaded
const eventTypesLoaded = {} // List of event types seen
let loadingStartTime, loadingEndTime // Used to track how long loading takes
let loadingProgressInterval // Used to update clients on loading progress

// const loadingProgressEvent = throttle(() => broadcastEvent('loadingProgressEvent', loadingStats()), 250, { leading: true, trailing: true })

const loadingProgressEvent = () => broadcastEvent('loadingProgress', loadingStats())

// Callback to be invoked when a file is loaded
// Fires every time a file is loaded or reloaded
const loadFileCallback = (file) => {
  if (!filesLoaded.includes(file.name)) {
    filesLoaded.push(file.name)
    logSizeInBytes += file.size
    if (file.lineCount) numberOfLogLines += file.lineCount
  }
}

// Callback when a log entry is loaded
// Fires once for each log entry, duplicate entries won't fire multiple events
const logEventCallback = (log) => {
  const eventName = log.event

  // Update stats
  numberOfEventsImported = eliteLog.stats().numberOfEventsImported

  // Add logic to handle broadcasting specific game events
  if (GAME_EVENT_TO_ICARUS_EVENT_MAP[eventName]) {
    // Only fire events *if* we are not loading (otherwise can generate
    // thousands of messages in a few seconds, which slows loading)
    if (!loadingInProgress) {
      // Fire off all ICARUS_EVENTS that depend on this game event
      GAME_EVENT_TO_ICARUS_EVENT_MAP[eventName].map(async (icarusEventName) => {
        const message = await ICARUS_EVENTS[icarusEventName].handler()
        broadcastEvent(icarusEventName, message)
      })
    }
  } else {
    // Keep track of all event types seen (and how many of each type)
    // TODO Move this into the EliteLog class
    if (!eventTypesLoaded[eventName]) eventTypesLoaded[eventName] = 0
    eventTypesLoaded[eventName]++
  }

  if (!loadingInProgress) broadcastEvent('newLogEntry', log)
}

// Callbacks are bound here so we can track data being parsed
eliteJson.loadFileCallback = loadFileCallback
eliteLog.loadFileCallback = loadFileCallback
eliteLog.logEventCallback = logEventCallback

const systemCache = {} // Crude hack until we have persistant storage

const eventHandlers = {
  hostInfo: () => {
    const urls = Object.values(os.networkInterfaces())
      .flat()
      .filter(({ family, internal }) => family === 'IPv4' && !internal)
      .map(({ address }) => `http://${address}:${PORT}`)
    return {
      urls
    }
  },
  loadingStats: () => loadingStats(),
  getCommander: async () => {
    const [LoadGame] = await Promise.all([eliteLog.getEvent('LoadGame')])
    return {
      commander: LoadGame?.Commander ?? UNKNOWN_VALUE,
      credits: LoadGame?.Credits ?? UNKNOWN_VALUE
    }
  },
  getLogEntries: async ({ count = 100, timestamp }) => {
    if (timestamp) {
      return await eliteLog.getFromTimestamp(timestamp)
    } else {
      return await eliteLog.getNewest(count)
    }
  },
  getSystem: async ({ name = null } = {}) => {
    let systemName = name
    const FSDJump = await eliteLog.getEvent('FSDJump')

    if (!systemName) {
      systemName = FSDJump?.StarSystem ?? UNKNOWN_VALUE
      if (systemName === UNKNOWN_VALUE) return null
    }

    // Use cache if we got an entry
    if (!systemCache[systemName]) {
      const [bodies, stations] = await Promise.all([
        EDSM.bodies(systemName),
        EDSM.stations(systemName)
      ])

      // Create cache entry
      systemCache[systemName] = new SystemMap({
        name: systemName,
        bodies,
        stations
      })
    }

    // TODO Handle when there is no data more explicitly
    let response = systemCache[systemName]

    if (FSDJump?.StarSystem === systemName) {
      response = {
        ...response,
        address: FSDJump?.SystemAddress ?? UNKNOWN_VALUE,
        position: FSDJump?.StarPos ?? UNKNOWN_VALUE,
        allegiance: FSDJump?.SystemAllegiance ?? UNKNOWN_VALUE,
        government: FSDJump?.SystemGovernment_Localised ?? UNKNOWN_VALUE,
        security: FSDJump?.SystemSecurity_Localised ?? UNKNOWN_VALUE,
        economy: {
          primary: FSDJump?.SystemEconomy_Localised ?? UNKNOWN_VALUE,
          secondary: FSDJump?.SystemSecondEconomy_Localised ?? UNKNOWN_VALUE
        },
        population: FSDJump?.Population ?? UNKNOWN_VALUE,
        faction: FSDJump?.SystemFaction?.Name ?? UNKNOWN_VALUE
      }
    } else {
      // TODO if last jump was not to this system, check database (or do a
      // lookup via an API) to get most recent info for this system
      response = {
        ...response,
        address: UNKNOWN_VALUE,
        position: UNKNOWN_VALUE,
        allegiance: UNKNOWN_VALUE,
        government: UNKNOWN_VALUE,
        security: UNKNOWN_VALUE,
        economy: {
          primary: UNKNOWN_VALUE,
          secondary: UNKNOWN_VALUE
        },
        population: UNKNOWN_VALUE,
        faction: UNKNOWN_VALUE
      }
    }

    return response
  }
}

async function init ({ days = 30 } = {}) {
  if (loadingComplete) return loadingStats() // If already run, don't run again

  loadingInProgress = true // True while initial loading is happening

  loadingProgressEvent()
  loadingProgressInterval = setInterval(loadingProgressEvent, 200)

  loadingStartTime = new Date()

  await eliteJson.load() // Load JSON files then watch for changes
  eliteJson.watch() // @TODO Pass a callback to handle new messages

  await eliteLog.load({ days }) // Load logs then watch for changes
  eliteLog.watch() // @TODO Pass a callback to handle new messages

  loadingInProgress = false // We are done with the loading phase
  loadingComplete = true // Set to true when data has been loaded
  loadingEndTime = new Date()

  clearInterval(loadingProgressInterval)
  loadingProgressEvent() // Trigger once complete

  return loadingStats()
}

function loadingStats () {
  return {
    loadingComplete,
    loadingInProgress,
    numberOfFiles: filesLoaded.length,
    numberOfEventsImported,
    numberOfLogLines,
    eventTypesLoaded,
    logSizeInBytes,
    lastActivity: eliteLog.stats().lastActivity,
    loadingTime: (loadingEndTime) ? loadingEndTime - loadingStartTime : new Date() - loadingStartTime
  }
}

module.exports = {
  eventHandlers,
  init
}
