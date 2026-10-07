import { contextBridge, ipcRenderer } from 'electron'

/**
 * Bridge for the floating button's window.
 *
 * Deliberately tiny: the page only reports clicks and drags, and the main
 * process decides what they mean. It gets none of the main window's API.
 *
 * The channel names are written out rather than imported from `@shared/ipc`:
 * sharing that module with the main preload makes the bundler split it into a
 * chunk both preloads `require`, and a sandboxed preload cannot load one. They
 * must match the FLOATING_* entries there.
 */
contextBridge.exposeInMainWorld('floating', {
  click: () => ipcRenderer.send('floating:click'),
  dragStart: () => ipcRenderer.send('floating:drag-start'),
  dragMove: () => ipcRenderer.send('floating:drag-move'),
  dragEnd: () => ipcRenderer.send('floating:drag-end')
})
