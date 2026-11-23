//! A drag's frame as Margin's window has it (step 3 commit 6): a session hosting a split in Margin's window 1, its
//! divider dragged and followed, and the window's page; for no_alloc.rs and drag_cost.rs.
#![allow(dead_code)]
use margin_ffi::*;
use std::ffi::c_void;

unsafe extern "C" {
    fn malloc(n: usize) -> *mut c_void;
}

/// The JSON ports' one answer: the engine shows a host, follows a drag, fills the page area.
pub extern "C" fn port(_: *mut c_void, _: *const u8, _: usize, out_len: *mut usize) -> *mut u8 {
    let a = br#"{"id":1,"host":"safari:p","follows":true,"fills":true,"follow":3,"visible":3}"#;
    // SAFETY: malloc'd here, freed by the session with free.
    unsafe {
        let p = malloc(a.len()) as *mut u8;
        std::ptr::copy_nonoverlapping(a.as_ptr(), p, a.len());
        *out_len = a.len();
        p
    }
}

pub extern "C" fn now(_: *mut c_void) -> f64 {
    1.0
}

/// The frames followed, and the rects' sum (a check they came).
pub extern "C" fn follow(ctx: *mut c_void, p: *const MarginPlacement, rects: *const MarginHostRect, n: usize) {
    // SAFETY: ctx is the test's counter; the call's lists as given.
    unsafe {
        let c = &mut *(ctx as *mut (usize, f64));
        c.0 += 1;
        c.1 += (*p).page.width;
        for i in 0..n {
            c.1 += (*rects.add(i)).rect.x + (*rects.add(i)).len as f64;
        }
    }
}

/// A report of a drag of the split's divider at `x` (two panes, the second's left edge moving).
pub fn report(x: u32) -> String {
    let a = 600 + x % 40;
    format!(
        r#"{{"insets":{{"left":260,"top":8,"right":8,"bottom":8}},"radius":10,"radii":[10,10,10,10],"container":{{"width":1512,"height":949}},"mode":"fullscreen","pageHosted":true,"fills":["rgb(20, 20, 20)","rgb(20, 20, 20)","rgb(20, 20, 20)","rgb(20, 20, 20)"],"split":"sp1","panes":[{{"id":"w1","rect":[260,8,{a},933]}},{{"id":"a2","rect":[{},8,{},933]}}]}}"#,
        268 + a,
        1504 - 268 - a
    )
}

pub struct World {
    pub session: *mut MarginSession,
    pub page: *mut MarginPage,
    pub library: *mut MarginLibrary,
    pub counter: Box<(usize, f64)>,
    _dir: tempfile::TempDir,
}

/// A session hosting a split of a web item and an app in Margin's window 1, its divider dragged and followed.
pub fn world() -> World {
    let dir = tempfile::tempdir().expect("a folder");
    let root = dir.path().to_string_lossy().to_string();
    // SAFETY: the root's bytes.
    let library = unsafe { margin_library_new(root.as_ptr(), root.len(), false, std::ptr::null_mut(), None) };
    let mut counter = Box::new((0usize, 0.0f64));
    let ctx = (&mut *counter as *mut (usize, f64)).cast::<c_void>();
    // SAFETY: the library; the counter as ctx (alive as long as the world).
    let session = unsafe { margin_session_new(library, std::ptr::null(), 0, ctx, Some(now), Some(port), None) };
    // SAFETY: the live session.
    unsafe { margin_session_set_follow(session, Some(follow)) };
    let input = |v: &str| {
        let mut len = 0;
        // SAFETY: the live session, the input's bytes; its answer freed.
        unsafe {
            let out = margin_session_input(session, v.as_ptr(), v.len(), std::ptr::null_mut(), &mut len);
            if !out.is_null() {
                margin_buffer_free(out, len);
            }
        }
    };
    input(
        r#"{"type":"state","set":{"hostingWindow":{"put":[[1]]},"open":{"put":[["w1","safari:s-0123456789abcdef0123456789abcdef","s-0123456789abcdef0123456789abcdef"],["a2","app:com.apple.TextEdit",null]]},"layouts":{"put":[[1,"w1",[260,8,600,933],[["a2","pane",[868,8,636,933]]],"w1","sp1"]]},"cards":{"put":[["s-0123456789abcdef0123456789abcdef",1,"w1",null,"https://c.example/","",true,true,false,null,null,null]]}}}"#,
    );
    input(r#"{"type":"sidebarResizing","window":1,"on":true,"divider":true}"#);
    let page = margin_page_new();
    // SAFETY: the live page.
    unsafe {
        margin_page_set_hosting(page, true);
        margin_page_set_full_screen(page, true);
    }
    World { session, page, library, counter, _dir: dir }
}

pub const CONTENT: MarginRect = MarginRect { x: 0.0, y: 0.0, width: 1512.0, height: 949.0 };
pub const DISPLAY: MarginRect = MarginRect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };

/// One frame as Margin's window has it: the report into its page, the page area again, the session told, the
/// holes placed. What the session did (1: followed).
///
/// # Safety
/// The world's live objects.
pub unsafe fn frame(w: &World, report: &[u8], card: Option<&MarginRect>) -> u8 {
    let mut rect = MarginRect::default();
    let mut radius = 0.0;
    let mut placed = MarginHolePlaced::default();
    // SAFETY: the caller's contract.
    unsafe {
        margin_page_set_layout(w.page, report.as_ptr(), report.len());
        margin_page_update(w.page, CONTENT, &DISPLAY, &mut rect, &mut radius);
        let said = margin_session_page_rect(
            w.session,
            1,
            w.page,
            CONTENT,
            &DISPLAY,
            card.map_or(std::ptr::null(), |c| c as *const MarginRect),
        );
        margin_page_place_hole(w.page, CONTENT, &mut placed);
        said
    }
}

impl Drop for World {
    fn drop(&mut self) {
        // SAFETY: made in `world`, freed once, the session before its library.
        unsafe {
            margin_session_free(self.session);
            margin_page_free(self.page);
            margin_library_free(self.library);
        }
    }
}
