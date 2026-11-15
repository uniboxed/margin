// The slot in the shell (Slot.swift): where the keeper meets the reads, the
// bindings and the layout.
//
// - Off unless `MarginNativeSlot` is set (Shell.forApp) and the launch check
//   passed the slot's calls. Off, there is no keeper, and nothing here does
//   anything: every window keeps the page box, exactly as before.
// - Every read of the window server goes through SlotWindows, so the binder,
//   the planner, the handoff and the covers read a slotted window at the
//   bounds it stands for (its full frame). The extension's own bounds for
//   that window are put in the same terms (slotModel). The keeper itself is
//   checked against the real bounds, once per read (slotsRead).
// - The layout: for a full-screen window drawn over whole, the layout's insets
//   are reserved in its Space and its copy is sent a layout with no insets
//   (the extension's existing "no box" path, first paint included). Anything
//   else, or a slot refused, gets the layout as before: the page box.
// - Given back: when its window leaves full screen, when its page takes the
//   screen (a video in full screen fills the display), when it's parked, when
//   no linked window is bound to it for longer than a dropped link is kept,
//   when the displays change, and at quit.

import AppKit

// The keeper, reachable from the window source the shell is made with.
final class SlotBox { var keeper: SlotKeeper? }

struct SlotWindows: WindowSource {
    let inner: WindowSource
    let box: SlotBox
    func windows(of pids: Set<pid_t>) -> [ServerWindow] {
        let list = inner.windows(of: pids)
        return box.keeper?.model(list) ?? list
    }
    func read(of pids: Set<pid_t>) -> [ServerWindow]? {
        inner.read(of: pids).map { box.keeper?.model($0) ?? $0 }
    }
    func above(_ window: Int) -> [ServerWindow]? {
        inner.above(window).map { box.keeper?.model($0) ?? $0 }
    }
}

extension Shell {
    var slots: SlotKeeper? {
        get { slotBox.keeper }
        set { slotBox.keeper = newValue }
    }

    // Beside the parked windows' marker: Application Support/Margin, or a harness's own folder.
    var slotMarkerURL: URL { parkingMarkerURL.deletingLastPathComponent().appendingPathComponent(SlotMarker.fileName) }

    // At launch: a crashed Margin's reservations given back whether or not the slot is on now (the
    // setting may have been turned off since), then the keeper, when it's on.
    func startSlots(spaces: SlotSpaces, reads: SpaceReads?) {
        let keeper = SlotKeeper(spaces: spaces, marker: slotMarkerURL)
        keeper.recover(fullScreen: reads?.fullScreenSpaces(), running: { pid in
            NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == Bundle.main.bundleIdentifier
        })
        guard options.slot, !options.hosted else {
            Diagnostics.note(options.hosted ? "slot: off (MarginHosted: Margin hosts the browser's window itself)" : "slot: off (MarginNativeSlot isn't set): the page box, as before")
            return
        }
        slots = keeper
        Diagnostics.note("slot: on: a full-screen window is sized to its page's place in the layout, the page box as the fallback")
    }

    // A window's full-screen Space (a harness may say).
    func fullScreenSpace(of number: Int) -> UInt64? {
        if let say = options.slotSpaceOf { return say(number) }
        guard let reads = spaceReads, let full = reads.fullScreenSpaces(), let spaces = reads.spaces(of: number) else { return nil }
        return spaces.first(where: full.contains)
    }

    // Each read, with the real bounds: every slot verified. One that failed (or the slot turned off)
    // has its window's layout sent again, as the page box this time.
    func slotsRead(_ raw: [ServerWindow]) {
        guard let slots else { return }
        let events = slots.read(raw, now: Diagnostics.now())
        let lost = events.contains { if case .landed = $0 { return false } else { return true } }
        if lost { reofferLayouts() }
    }

    // A copy's own bounds for a slotted window, as the model has them (and no part of it Safari's own:
    // the layout stays over the whole display).
    func slotModel(_ w: ExtWindow) -> ExtWindow {
        guard let slots, let number = matches[w.key], slots.serves(number), let bounds = w.bounds else { return w }
        var modelled = w
        modelled.bounds = slots.model(bounds, of: number)
        modelled.viewport = nil
        return modelled
    }

    // After the bindings: slots whose windows no longer want them given back, and windows that have a
    // layout and no slot asked again (a page out of its own full screen, a Space that had to be given
    // back first).
    func tendSlots(_ ext: [WindowKey: (ExtWindow, Link)]) {
        guard let slots else { return }
        let now = Diagnostics.now()
        var keyOf: [Int: WindowKey] = [:]
        for (key, number) in matches { keyOf[number] = key }
        for number in slots.slots.keys.sorted() {
            guard let key = keyOf[number], let (w, _) = ext[key] else {
                let since = slotUnboundSince[number] ?? now
                slotUnboundSince[number] = since
                if now - since > options.reconnectGrace {
                    slotUnboundSince[number] = nil
                    slots.release(number, why: "no linked window is bound to it")
                }
                continue
            }
            slotUnboundSince[number] = nil
            if w.state != "fullscreen" { slots.release(number, why: "its window left full screen") }
            else if w.pageFullscreen { slots.release(number, why: "its page took the screen") }
            else if isParkedKey(key) { slots.release(number, why: "its window is parked") }
        }
        slotUnboundSince = slotUnboundSince.filter { slots.serves($0.key) }
        slotLayouts = slotLayouts.filter { overlays[$0.key] != nil }
        for (key, layout) in slotLayouts.sorted(by: { $0.key < $1.key }) {
            guard let number = matches[key], !slots.serves(number), let overlay = overlays[key], overlay.isShown,
                  let (w, _) = ext[key], w.state == "fullscreen", !w.pageFullscreen else { continue }
            layoutChanged(overlay, layout)
        }
    }

    // The layout a window's copy is sent: with no insets when the slot takes them (the page is then
    // the whole window), as it is otherwise. `layout` is in the window's own terms; `window` its bounds
    // as the shell reads them (its full frame).
    func slotLayout(_ overlay: OverlayController, _ layout: PageLayout, window: CGRect) -> PageLayout {
        guard let slots, let number = matches[overlay.key] else { return layout }
        guard overlay.windowFullScreen, !overlay.pageFullscreen, layout.mode == "fullscreen", overlay.frameTopLeft == window,
              fillsDisplay(window), let space = fullScreenSpace(of: number) else {
            slots.release(number, why: "its layout isn't one for the whole full-screen window")
            return layout
        }
        let edges = SlotEdges(left: layout.left, right: layout.right, top: layout.top, bottom: layout.bottom)
        guard slots.want(number: number, space: space, bounds: window, edges: edges, now: Diagnostics.now()) == .slot else { return layout }
        let page = edges.whole.inset(window)
        return PageLayout(left: 0, top: 0, right: 0, bottom: 0, radius: 0, radii: [0, 0, 0, 0], width: Double(page.width), height: Double(page.height), mode: layout.mode)
    }

    // Every window's last layout offered again (what's sent only when it differs from the last one sent).
    func reofferLayouts() {
        for (key, layout) in slotLayouts.sorted(by: { $0.key < $1.key }) {
            if let overlay = overlays[key] { layoutChanged(overlay, layout) }
        }
    }

    // The displays changed: every window's full frame may have. Everything given back; each window's next
    // layout (measured at its new size) reserves again.
    func slotsDisplaysChanged() {
        guard let slots, !slots.slots.isEmpty else { return }
        slots.releaseAll(why: "the displays changed")
    }
}
