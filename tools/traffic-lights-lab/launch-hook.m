// Opt-in launch experiment for a disposable, loader-permissive Chromium build only.
// No swizzling, persistent preferences, library-validation bypass or system changes.
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import <libproc.h>

@interface NSWindow (ResearchPrivateButtons)
- (NSButton *)_findStandardWindowButton:(NSUInteger)kind;
@end
@interface NSView (ResearchPrivateHidden)
- (void)_setHidden:(BOOL)hidden setNeedsDisplay:(BOOL)display;
@end

static NSString *runDirectory;
static NSMapTable<NSButton *, NSNumber *> *original;
static __weak NSWindow *targetWindow;
static BOOL active;

static BOOL applyHidden(NSWindow *window) {
    Method find = class_getInstanceMethod(window.class, @selector(_findStandardWindowButton:));
    if (!find || strcmp(method_getTypeEncoding(find), "@24@0:8Q16")) return NO;
    for (NSUInteger i = 0; i < 3; ++i) {
        NSButton *button = [window _findStandardWindowButton:i];
        Method hide = class_getInstanceMethod(button.class, @selector(_setHidden:setNeedsDisplay:));
        if (!button || !hide || strcmp(method_getTypeEncoding(hide), "v24@0:8B16B20")) return NO;
        if (![original objectForKey:button]) [original setObject:@(button.hidden) forKey:button];
        [button _setHidden:YES setNeedsDisplay:YES];
    }
    return YES;
}

static void restore(void) {
    active = NO;
    for (NSButton *button in original) {
        [button _setHidden:[[original objectForKey:button] boolValue] setNeedsDisplay:YES];
    }
    [original removeAllObjects];
}

static NSArray *buttonState(NSWindow *window) {
    NSMutableArray *result = NSMutableArray.array;
    for (NSUInteger i = 0; i < 3; ++i) {
        NSButton *button = [window _findStandardWindowButton:i];
        if (!button) continue;
        NSPoint center = NSMakePoint(NSMidX(button.frame), NSMidY(button.frame));
        [result addObject:@{@"type": @(i), @"hidden": @(button.hiddenOrHasHiddenAncestor),
                           @"alpha": @(button.alphaValue), @"hit": @([button.superview hitTest:center] == button)}];
    }
    return result;
}

__attribute__((constructor)) static void startResearchHook(void) {
    const char *expected = getenv("MARGIN_BUTTONS_TARGET_EXECUTABLE");
    const char *directory = getenv("MARGIN_BUTTONS_DIR");
    char executable[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (!expected || !directory || proc_pidpath(getpid(), executable, sizeof(executable)) <= 0 || strcmp(expected, executable)) return;
    // Only the explicitly launched browser loads the component; helpers do not inherit it.
    unsetenv("DYLD_INSERT_LIBRARIES");
    NSString *executablePath = @(executable);
    @autoreleasepool { runDirectory = [[NSString alloc] initWithUTF8String:directory]; }
    dispatch_async(dispatch_get_main_queue(), ^{
        original = [NSMapTable weakToStrongObjectsMapTable];
        NSString *loadedPath = [runDirectory stringByAppendingPathComponent:@"hook-loaded.json"];
        NSData *loaded = [NSJSONSerialization dataWithJSONObject:@{@"pid": @(getpid()), @"executable": executablePath} options:0 error:nil];
        [loaded writeToFile:loadedPath atomically:YES];
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:45];
        __block id resizeObserver = [[NSNotificationCenter defaultCenter] addObserverForName:NSWindowDidResizeNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            if (active && note.object == targetWindow && !applyHidden(targetWindow)) restore();
        }];
        [NSTimer scheduledTimerWithTimeInterval:0.04 repeats:YES block:^(NSTimer *timer) {
            if ([deadline timeIntervalSinceNow] <= 0) {
                restore(); [[NSNotificationCenter defaultCenter] removeObserver:resizeObserver]; resizeObserver = nil;
                [timer invalidate]; return;
            }
            NSString *path = [runDirectory stringByAppendingPathComponent:@"hook-command.json"];
            NSData *data = [NSData dataWithContentsOfFile:path];
            if (!data) return;
            NSDictionary *command = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
            [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
            if (![command isKindOfClass:NSDictionary.class]) return;
            NSWindow *window = nil;
            for (NSWindow *candidate in NSApp.windows) if (candidate.windowNumber == [command[@"window"] integerValue]) window = candidate;
            BOOL valid = window && window.visible && (window.styleMask & NSWindowStyleMaskTitled) && !(window.styleMask & NSWindowStyleMaskFullScreen);
            NSString *action = command[@"action"];
            BOOL success = NO;
            if ([action isEqual:@"restore"]) { restore(); success = YES; }
            else if (valid && [action isEqual:@"hide"]) { targetWindow = window; success = applyHidden(window); active = success; if (!success) restore(); }
            else if (valid && [action isEqual:@"inspect"]) success = YES;
            NSDictionary *reply = @{@"id": command[@"id"] ?: @"", @"action": action ?: @"", @"pid": @(getpid()),
                                    @"window": @(window.windowNumber), @"success": @(success),
                                    @"windowed": @(valid), @"buttons": valid ? buttonState(window) : @[]};
            [[NSJSONSerialization dataWithJSONObject:reply options:0 error:nil] writeToFile:[runDirectory stringByAppendingPathComponent:@"hook-response.json"] atomically:YES];
        }];
    });
}
