import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { useSocket, sendEvent, eventListener } from 'lib/socket'
import Layout from 'components/layout'
import Panel from 'components/panel'
import { NavPanelNavItems } from 'lib/navigation-items'
import NavigationListPanel from 'components/panels/navigation/navigation-list-panel'
import NavigationInspectorPanel from 'components/panels/navigation/navigation-inspector-panel'

// TODO Refactor to reduce code duplication
export default function NavListPage () {
  const router = useRouter()
  const { query } = router
  const { connected, active, ready } = useSocket()
  const [system, setSystem] = useState()
  const [systemObject, setSystemObject] = useState()

  const setSystemObjectByName = (name) => {
    if (!name) setSystemObject(null)
    const el = document.querySelector(`[data-system-object-name="${name}" i]`)
    if (el) {
      el.focus()
    } else {
      const newSystemObject = system.objectsInSystem.filter(child => child.name.toLowerCase() === name?.toLowerCase())[0]
      setSystemObject(newSystemObject)
    }
  }

  useEffect(async () => {
    if (!connected || !router.isReady) return
    const newSystem = await sendEvent('getSystem', query.system ? { name: query.system, useCache: false } : null)
    if (newSystem) setSystem(newSystem)

    if (query.selected) {
      const newSystemObject = newSystem.objectsInSystem.filter(child => child.name.toLowerCase() === query.selected.toLowerCase())[0]
      if (newSystemObject) {
        const el = document.querySelector(`[data-system-object-name="${newSystemObject.name}" i]`)
        if (el) el.focus()
      }
    }
  }, [connected, ready, router.isReady])

  useEffect(() => eventListener('newLogEntry', async (log) => {
    if (['FSDJump', 'FSSDiscoveryScan', 'FSSAllBodiesFound', 'Scan'].includes(log.event)) {
      const newSystem = await sendEvent('getSystem', { name: system?.name, useCache: false })
      if (!newSystem) return // If no result, don't update map
      if (log.event === 'FSDJump') setSystemObject(null) // If FSD Jump, clear selected object
      setSystem(newSystem)
    }
  }), [system])

  useEffect(() => {
    if (!router.isReady) return
    const q = { ...query }
    if (system) q.system = system?.name?.toLowerCase()
    if (systemObject) {
      q.selected = systemObject?.name?.toLowerCase()
    } else {
      if (q.selected) delete q.selected
    }
    router.push({ query: q }, undefined, { shallow: true })
  }, [system, systemObject, router.isReady])

  return (
    <Layout connected={connected} active={active} ready={ready}>
      <Panel layout='full-width' navigation={NavPanelNavItems('List', query)}>
        <NavigationListPanel system={system} systemObject={systemObject} setSystemObject={setSystemObject} />
        <NavigationInspectorPanel systemObject={systemObject} setSystemObjectByName={setSystemObjectByName} />
      </Panel>
    </Layout>
  )
}
