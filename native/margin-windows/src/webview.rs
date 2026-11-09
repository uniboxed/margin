//! WebView2 in each overlay (app/shell/OverlayWebView.swift's counterpart). Windows only.
//!
//! - One environment per app (`WebViewEnv`), its user data folder `%LOCALAPPDATA%\Margin\WebView2`; one web
//!   view per overlay, made with the composition controller (visual hosting): its content is a
//!   DirectComposition visual in the overlay's window, so `DefaultBackgroundColor` with alpha 0 really shows
//!   the browser through the page's transparent pixels. The app forwards the mouse (overlay.rs → `connect`)
//!   and shows the cursor the web view asks for; the keyboard reaches it by focus (`focus`).
//! - Margin's files from `https://margin.invalid/…`, answered by the app from memory (serve.rs) with the Mac's
//!   Content-Security-Policy, through `WebResourceRequested` for every URL and every kind of request; every
//!   other request is answered 403, so nothing reaches the network, as on the Mac. Navigations anywhere but
//!   the page, new windows, frames, downloads, external schemes and permissions are refused.
//! - No dev tools, no context menu, no zoom or pinch, no status bar, no default script dialogs, no autofill,
//!   no swipe navigation, no SmartScreen lookups (network), and the browser's accelerator keys off (F5, Ctrl+F,
//!   Ctrl+P…): the page gets its keys, the browser none.
//! - The bridge (bridge.rs): the page's `chrome.webview.postMessage({ id, op, … })` → an `IncomingOp` with a
//!   `Reply` the shell answers (`PostWebMessageAsJson`); `receive(json)` runs `marginApp.receive(<json>)`.
//!
//! Everything here runs on the UI thread: WebView2's callbacks come through its message loop.

use std::cell::{Cell, RefCell};
use std::path::Path;
use std::rc::{Rc, Weak};

use serde_json::{Map, Value};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    CoreWebView2EnvironmentOptions, CreateCoreWebView2CompositionControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, CursorChangedEventHandler, DownloadStartingEventHandler,
    ExecuteScriptCompletedHandler, LaunchingExternalUriSchemeEventHandler, NavigationCompletedEventHandler,
    NavigationStartingEventHandler, NewWindowRequestedEventHandler, PermissionRequestedEventHandler,
    ProcessFailedEventHandler, WebMessageReceivedEventHandler, WebResourceRequestedEventHandler, take_pwstr,
};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice2, IDCompositionDevice, IDCompositionTarget, IDCompositionVisual,
};
use windows::Win32::UI::Shell::SHCreateMemStream;
use windows::Win32::UI::WindowsAndMessaging::HCURSOR;
use windows::core::{BOOL, HSTRING, Interface, PCWSTR, PWSTR};

use crate::bridge::{is_page_source, parse_page_message, receive_script, reply_json};
use crate::log;
use crate::overlay::{MouseInput, MouseSink, Overlay};
use crate::serve::{self, Answer, OverlayFiles};
use crate::win::error_text;

type WinResult<T> = windows::core::Result<T>;

/// The one WebView2 environment, and the DirectComposition device the overlays' visuals come from.
pub struct WebViewEnv {
    env: ICoreWebView2Environment,
    dcomp: IDCompositionDevice,
    files: OverlayFiles,
}

impl WebViewEnv {
    /// Starts the environment; `done` runs on the UI thread once it's there (or failed: no WebView2
    /// Runtime, a user data folder that can't be used).
    pub fn create(user_data: &Path, files: OverlayFiles, done: impl FnOnce(Result<Rc<WebViewEnv>, String>) + 'static) {
        if !files.has_page() {
            log::warn("webview: no overlay.html among the overlay's files (dist/app beside margin.exe)");
        }
        // A transparent first frame, before the controller's own background color is set.
        // SAFETY: on Windows, setting a variable is thread-safe (SetEnvironmentVariableW); nothing in this
        // process reads the environment through a pointer it could invalidate.
        unsafe { std::env::set_var("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "00000000") };
        // SAFETY: no rendering device: DirectComposition makes its own.
        let dcomp: IDCompositionDevice = match unsafe { DCompositionCreateDevice2(None::<&windows::core::IUnknown>) } {
            Ok(d) => d,
            Err(e) => return done(Err(format!("no DirectComposition device: {}", error_text(e)))),
        };
        let options = CoreWebView2EnvironmentOptions::default();
        // SAFETY: plain setters of the options object, before it's handed over.
        unsafe {
            // Nothing in the background: no component updates, no metrics, no field trials over the network.
            options.set_additional_browser_arguments("--disable-background-networking".to_string());
            options.set_enable_tracking_prevention(true);
        }
        let options: ICoreWebView2EnvironmentOptions = options.into();
        let mut done = Some(done);
        let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |hr, env| {
            let Some(done) = done.take() else { return Ok(()) };
            match (hr, env) {
                (Ok(()), Some(env)) => done(Ok(Rc::new(WebViewEnv { env, dcomp, files }))),
                (Err(e), _) => done(Err(format!("no WebView2 environment: {}", error_text(e)))),
                (Ok(()), None) => done(Err("no WebView2 environment".into())),
            }
            Ok(())
        }));
        let folder = HSTRING::from(user_data.as_os_str());
        // SAFETY: strings are null-terminated and alive for the call; the handler is a COM object WebView2
        // keeps until it calls it, on this thread.
        let started = unsafe { CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), &folder, &options, &handler) };
        if let Err(e) = started {
            log::warn(format!(
                "webview: the environment didn't start: {} (is the WebView2 Runtime installed?)",
                error_text(e)
            ));
        }
    }
}

/// Something about a web view the shell should know.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WebViewEvent {
    /// The page loaded (or failed to).
    Loaded { ok: bool },
    /// Its renderer (or the browser process) died: `kind` is COREWEBVIEW2_PROCESS_FAILED_KIND. Reload it.
    Crashed { kind: i32 },
}

/// One message from the page, and the way to answer it.
pub struct IncomingOp {
    pub op: String,
    pub body: Map<String, Value>,
    pub reply: Reply,
}

/// The answer to one page message. Dropped unanswered, it answers `ok: true, value: null` (the Mac's
/// `replyHandler(nil, nil)` for the ops that only tell). Messages without an id get no answer at all.
pub struct Reply {
    id: Option<Value>,
    target: Weak<Inner>,
    sent: bool,
}

impl Reply {
    pub fn ok(mut self, value: Value) {
        self.send(Ok(value));
    }

    pub fn err(mut self, error: impl Into<String>) {
        self.send(Err(error.into()));
    }

    /// Whether the page waits for an answer.
    pub fn wanted(&self) -> bool {
        self.id.is_some()
    }

    fn send(&mut self, result: Result<Value, String>) {
        if self.sent {
            return;
        }
        self.sent = true;
        let (Some(id), Some(inner)) = (self.id.as_ref(), self.target.upgrade()) else { return };
        if inner.closed.get() {
            return;
        }
        let json = HSTRING::from(reply_json(id, result));
        // SAFETY: the web view is open (not closed) and on this thread; the string is null-terminated.
        if let Err(e) = unsafe { inner.webview.PostWebMessageAsJson(&json) } {
            log::warn(format!("webview: a reply didn't go: {}", error_text(e)));
        }
    }
}

impl Drop for Reply {
    fn drop(&mut self) {
        self.send(Ok(Value::Null));
    }
}

/// A callback kept in a cell (taken by `try_borrow_mut` while it runs).
type Callback<T> = RefCell<Option<Box<dyn FnMut(T)>>>;

struct Inner {
    controller: ICoreWebView2Controller,
    composition: ICoreWebView2CompositionController,
    webview: ICoreWebView2,
    // Kept alive with the web view: the window's composition target and the visuals in it.
    _target: IDCompositionTarget,
    _root: IDCompositionVisual,
    _visual: IDCompositionVisual,
    on_op: Callback<IncomingOp>,
    on_cursor: Callback<HCURSOR>,
    on_event: Callback<WebViewEvent>,
    closed: Cell<bool>,
    refused: Cell<u64>,
}

/// One overlay's web view. Dropping it closes it.
pub struct WebView(Rc<Inner>);

fn pwstr(get: impl FnOnce(*mut PWSTR) -> WinResult<()>) -> WinResult<String> {
    let mut p = PWSTR::null();
    get(&mut p)?;
    Ok(take_pwstr(p))
}

impl WebView {
    /// A web view in `parent` (an overlay's window), `size` its client size in pixels; `done` runs on the UI
    /// thread once it's made (not yet navigated: `navigate`).
    pub fn create(
        env: &Rc<WebViewEnv>,
        parent: HWND,
        size: (i32, i32),
        done: impl FnOnce(Result<WebView, String>) + 'static,
    ) {
        let env3: ICoreWebView2Environment3 = match env.env.cast() {
            Ok(e) => e,
            Err(e) => return done(Err(format!("WebView2 too old for visual hosting: {}", error_text(e)))),
        };
        let env = env.clone();
        let mut done = Some(done);
        let handler = CreateCoreWebView2CompositionControllerCompletedHandler::create(Box::new(move |hr, comp| {
            let Some(done) = done.take() else { return Ok(()) };
            let made = hr.and_then(|_| {
                comp.ok_or_else(|| windows::core::Error::from_hresult(windows::Win32::Foundation::E_POINTER))
            });
            match made.and_then(|comp| setup(&env, parent, size, comp)) {
                Ok(w) => done(Ok(w)),
                Err(e) => done(Err(format!("the web view wasn't made: {}", error_text(e)))),
            }
            Ok(())
        }));
        // SAFETY: `parent` is our overlay window, alive; the handler is called later on this thread.
        if let Err(e) = unsafe { env3.CreateCoreWebView2CompositionController(parent, &handler) } {
            log::warn(format!("webview: CreateCoreWebView2CompositionController failed: {}", error_text(e)));
        }
    }

    /// Loads the overlay page.
    pub fn navigate(&self) {
        // SAFETY: an open web view on this thread; a null-terminated URL.
        if let Err(e) = unsafe { self.0.webview.Navigate(&HSTRING::from(serve::PAGE)) } {
            log::warn(format!("webview: Navigate failed: {}", error_text(e)));
        }
    }

    /// Hands the page one message (`json`: its JSON text) as `marginApp.receive(json)`.
    pub fn receive(&self, json: &str) {
        if self.0.closed.get() {
            return;
        }
        let script = HSTRING::from(receive_script(json));
        let handler = ExecuteScriptCompletedHandler::create(Box::new(|hr, _| {
            if let Err(e) = hr {
                log::warn(format!("webview: a push into the page failed: {}", error_text(e)));
            }
            Ok(())
        }));
        // SAFETY: an open web view on this thread; the script is null-terminated; the handler runs later here.
        if let Err(e) = unsafe { self.0.webview.ExecuteScript(&script, &handler) } {
            log::warn(format!("webview: ExecuteScript failed: {}", error_text(e)));
        }
    }

    /// What the page says, with a way to answer.
    pub fn on_op(&self, f: impl FnMut(IncomingOp) + 'static) {
        *self.0.on_op.borrow_mut() = Some(Box::new(f));
    }

    /// The cursor the page wants over it (connect hands it to the overlay).
    pub fn on_cursor(&self, f: impl FnMut(HCURSOR) + 'static) {
        *self.0.on_cursor.borrow_mut() = Some(Box::new(f));
    }

    pub fn on_event(&self, f: impl FnMut(WebViewEvent) + 'static) {
        *self.0.on_event.borrow_mut() = Some(Box::new(f));
    }

    /// Its size, in the overlay's client pixels (from its top left).
    pub fn resize(&self, width: i32, height: i32) {
        let r = RECT { left: 0, top: 0, right: width.max(1), bottom: height.max(1) };
        // SAFETY: an open controller on this thread.
        if let Err(e) = unsafe { self.0.controller.SetBounds(r) } {
            log::warn(format!("webview: SetBounds failed: {}", error_text(e)));
        }
    }

    /// Hidden web views stop drawing and slow their timers (the Mac keeps the page drawn while put away: the
    /// shell keeps it visible and hides the overlay's window instead, unless memory matters more).
    pub fn set_visible(&self, on: bool) {
        // SAFETY: an open controller on this thread.
        let _ = unsafe { self.0.controller.SetIsVisible(on) };
    }

    /// The keyboard to the page (after overlay.rs `take_keyboard`).
    pub fn focus(&self) {
        // SAFETY: an open controller on this thread.
        let _ = unsafe { self.0.controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
    }

    /// One mouse event, in the web view's pixels.
    pub fn mouse(&self, input: &MouseInput) {
        send_mouse(&self.0, input);
    }

    /// Where the overlay's mouse input goes (overlay.rs `set_mouse_sink`).
    pub fn mouse_sink(&self) -> Box<dyn MouseSink> {
        Box::new(Sink(Rc::downgrade(&self.0)))
    }

    /// Requests the app has refused so far (for the log: never their addresses).
    pub fn refused(&self) -> u64 {
        self.0.refused.get()
    }

    pub fn close(&self) {
        if self.0.closed.replace(true) {
            return;
        }
        // SAFETY: an open controller on this thread; Close releases the web view and its handlers.
        let _ = unsafe { self.0.controller.Close() };
    }
}

impl Drop for WebView {
    fn drop(&mut self) {
        self.close();
    }
}

/// Wires an overlay and its web view together: the mouse to the page, the page's cursor to the overlay.
pub fn connect(overlay: &Rc<Overlay>, webview: &WebView) {
    overlay.set_mouse_sink(webview.mouse_sink());
    let weak = Rc::downgrade(overlay);
    webview.on_cursor(move |c| {
        if let Some(o) = weak.upgrade() {
            o.set_cursor(c);
        }
    });
}

struct Sink(Weak<Inner>);

impl MouseSink for Sink {
    fn mouse(&self, input: &MouseInput) {
        if let Some(inner) = self.0.upgrade() {
            send_mouse(&inner, input);
        }
    }
}

fn send_mouse(inner: &Inner, input: &MouseInput) {
    if inner.closed.get() {
        return;
    }
    // WebView2's mouse event kinds and virtual keys have the WM_ and MK_ values.
    // SAFETY: an open composition controller on this thread.
    let _ = unsafe {
        inner.composition.SendMouseInput(
            COREWEBVIEW2_MOUSE_EVENT_KIND(input.msg as i32),
            COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS(input.keys as i32),
            input.data,
            POINT { x: input.x, y: input.y },
        )
    };
}

fn tell(inner: &Weak<Inner>, event: WebViewEvent) {
    let Some(inner) = inner.upgrade() else { return };
    if let Ok(mut f) = inner.on_event.try_borrow_mut()
        && let Some(f) = f.as_mut()
    {
        f(event);
    }
}

/// The overlay page, with or without a fragment or query: the only navigation allowed.
fn is_page(uri: &str) -> bool {
    is_page_source(uri)
}

fn setup(
    env: &Rc<WebViewEnv>,
    parent: HWND,
    size: (i32, i32),
    composition: ICoreWebView2CompositionController,
) -> WinResult<WebView> {
    // SAFETY (the whole function): COM calls on objects made on this thread, with live arguments; every
    // handler is a COM object WebView2 holds and calls back on this thread.
    unsafe {
        let controller: ICoreWebView2Controller = composition.cast()?;
        let webview = controller.CoreWebView2()?;

        // The visual: a target on the overlay's window, a root, and the web view's visual in it.
        let target = env.dcomp.CreateTargetForHwnd(parent, true)?;
        let root = env.dcomp.CreateVisual()?;
        target.SetRoot(&root)?;
        let visual = env.dcomp.CreateVisual()?;
        root.AddVisual(&visual, true, None::<&IDCompositionVisual>)?;
        composition.SetRootVisualTarget(&visual)?;
        env.dcomp.Commit()?;

        if let Ok(c2) = controller.cast::<ICoreWebView2Controller2>() {
            c2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 })?;
        }
        controller.SetBounds(RECT { left: 0, top: 0, right: size.0.max(1), bottom: size.1.max(1) })?;
        controller.SetIsVisible(true)?;

        let s = webview.Settings()?;
        s.SetAreDevToolsEnabled(false)?;
        s.SetAreDefaultContextMenusEnabled(false)?;
        s.SetIsZoomControlEnabled(false)?;
        s.SetIsStatusBarEnabled(false)?;
        s.SetAreDefaultScriptDialogsEnabled(false)?;
        s.SetIsBuiltInErrorPageEnabled(false)?;
        s.SetAreHostObjectsAllowed(false)?;
        s.SetIsWebMessageEnabled(true)?;
        s.SetIsScriptEnabled(true)?;
        // The newer settings, where the runtime has them.
        if let Ok(s3) = s.cast::<ICoreWebView2Settings3>() {
            s3.SetAreBrowserAcceleratorKeysEnabled(false)?;
        }
        if let Ok(s4) = s.cast::<ICoreWebView2Settings4>() {
            s4.SetIsPasswordAutosaveEnabled(false)?;
            s4.SetIsGeneralAutofillEnabled(false)?;
        }
        if let Ok(s5) = s.cast::<ICoreWebView2Settings5>() {
            s5.SetIsPinchZoomEnabled(false)?;
        }
        if let Ok(s6) = s.cast::<ICoreWebView2Settings6>() {
            s6.SetIsSwipeNavigationEnabled(false)?;
        }
        if let Ok(s8) = s.cast::<ICoreWebView2Settings8>() {
            s8.SetIsReputationCheckingRequired(false)?;
        }

        let inner = Rc::new(Inner {
            controller,
            composition: composition.clone(),
            webview: webview.clone(),
            _target: target,
            _root: root,
            _visual: visual,
            on_op: RefCell::new(None),
            on_cursor: RefCell::new(None),
            on_event: RefCell::new(None),
            closed: Cell::new(false),
            refused: Cell::new(0),
        });
        let mut token = 0i64;

        // Every request: Margin's files, or 403.
        match webview.cast::<ICoreWebView2_22>() {
            Ok(w22) => w22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                &HSTRING::from("*"),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            )?,
            Err(_) => {
                webview.AddWebResourceRequestedFilter(&HSTRING::from("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?
            }
        }
        let (weak, env_c) = (Rc::downgrade(&inner), env.clone());
        webview.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let request = args.Request()?;
                let uri = pwstr(|p| request.Uri(p))?;
                let method = pwstr(|p| request.Method(p))?;
                let (status, reason, headers, body): (i32, &str, String, &[u8]) =
                    match serve::answer(&env_c.files, &uri, &method) {
                        Answer::File { body, content_type } => {
                            (200, "OK", serve::headers_ok(content_type, body.len()), body)
                        }
                        Answer::Refused => {
                            if let Some(inner) = weak.upgrade() {
                                let n = inner.refused.get() + 1;
                                inner.refused.set(n);
                                if n == 1 || n % 100 == 0 {
                                    log::note(format!(
                                        "webview: a request that isn't Margin's file refused ({n} so far)"
                                    ));
                                }
                            }
                            (403, "Forbidden", serve::headers_refused(), b"")
                        }
                    };
                let stream = SHCreateMemStream(Some(body));
                let response = env_c.env.CreateWebResourceResponse(
                    stream.as_ref(),
                    status,
                    &HSTRING::from(reason),
                    &HSTRING::from(headers),
                )?;
                args.SetResponse(&response)
            })),
            &mut token,
        )?;

        // Navigations: only to the page.
        webview.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let uri = pwstr(|p| args.Uri(p))?;
                if !is_page(&uri) {
                    args.SetCancel(true)?;
                    log::note("webview: a navigation away from the overlay page cancelled");
                }
                Ok(())
            })),
            &mut token,
        )?;
        // No frames (the policy says frame-src 'none' too).
        webview.add_FrameNavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetCancel(true)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
        webview.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetHandled(true)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
        webview.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
        if let Ok(w4) = webview.cast::<ICoreWebView2_4>() {
            w4.add_DownloadStarting(
                &DownloadStartingEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetCancel(true)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
        }
        if let Ok(w18) = webview.cast::<ICoreWebView2_18>() {
            w18.add_LaunchingExternalUriScheme(
                &LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetCancel(true)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
        }

        // The page's messages.
        let weak = Rc::downgrade(&inner);
        webview.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let (Some(args), Some(inner)) = (args, weak.upgrade()) else { return Ok(()) };
                let source = pwstr(|p| args.Source(p))?;
                if !is_page_source(&source) {
                    log::warn("webview: a message from something that isn't the overlay page dropped");
                    return Ok(());
                }
                let json = pwstr(|p| args.WebMessageAsJson(p))?;
                let m = match parse_page_message(&json) {
                    Ok(m) => m,
                    Err(why) => {
                        log::warn(format!("webview: a page message dropped: {why}"));
                        return Ok(());
                    }
                };
                let reply = Reply { id: m.id, target: Rc::downgrade(&inner), sent: false };
                let op = IncomingOp { op: m.op, body: m.body, reply };
                match inner.on_op.try_borrow_mut() {
                    Ok(mut f) => match f.as_mut() {
                        Some(f) => f(op),
                        None => op.reply.err("no overlay"),
                    },
                    Err(_) => op.reply.err("busy"),
                }
                Ok(())
            })),
            &mut token,
        )?;

        let weak = Rc::downgrade(&inner);
        composition.add_CursorChanged(
            &CursorChangedEventHandler::create(Box::new(move |sender, _| {
                let (Some(sender), Some(inner)) = (sender, weak.upgrade()) else { return Ok(()) };
                let mut cursor = HCURSOR::default();
                sender.Cursor(&mut cursor)?;
                if let Ok(mut f) = inner.on_cursor.try_borrow_mut()
                    && let Some(f) = f.as_mut()
                {
                    f(cursor);
                }
                Ok(())
            })),
            &mut token,
        )?;

        let weak = Rc::downgrade(&inner);
        webview.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                let mut ok = BOOL(0);
                if let Some(args) = args {
                    args.IsSuccess(&mut ok)?;
                }
                tell(&weak, WebViewEvent::Loaded { ok: ok.as_bool() });
                Ok(())
            })),
            &mut token,
        )?;
        let weak = Rc::downgrade(&inner);
        webview.add_ProcessFailed(
            &ProcessFailedEventHandler::create(Box::new(move |_, args| {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(-1);
                if let Some(args) = args {
                    args.ProcessFailedKind(&mut kind)?;
                }
                log::warn(format!("webview: a WebView2 process failed (kind {})", kind.0));
                tell(&weak, WebViewEvent::Crashed { kind: kind.0 });
                Ok(())
            })),
            &mut token,
        )?;

        Ok(WebView(inner))
    }
}
