// No AX in the backend. AX calls below are a permission preflight/negative control.
// Only a separate disposable child window is changed; no real browser is launched.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <objc/runtime.h>
#include <dlfcn.h>
#include <sys/sysctl.h>
#include <unistd.h>

static NSString *root;
static void *sky, *cg;
static uint32_t cid;
static NSTask *child;
static NSMutableArray *owned, *notices;
static NSLock *noticeLock;
static void (^tracking)(uint32_t);
static uint32_t trackedTarget;
static void emit(NSDictionary *row) {
    puts([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:row options:NSJSONWritingSortedKeys error:nil] encoding:NSUTF8StringEncoding].UTF8String);
}
static void finish(int status, NSString *reason) {
    if (child.running) { [child terminate]; [child waitUntilExit]; }
    for (NSNumber *wid in owned) {
        int (*releaseWindow)(uint32_t,uint32_t) = dlsym(sky,"SLSReleaseWindow");
        releaseWindow(cid,wid.unsignedIntValue);
    }
    emit(@{@"complete": @YES, @"status": @(status), @"reason": reason,
           @"childExited": @(child == nil || !child.running), @"nativeButtonsRemoved": @NO});
    exit(status);
}
static void require(BOOL condition, NSString *reason) { if (!condition) finish(2,reason); }
static void *symbol(void *handle, const char *name) {
    void *value = dlsym(handle,name); require(value != NULL,@(name)); return value;
}
#define SKY(name, type) ((type)symbol(sky, name))
#define CG(name, type) ((type)symbol(cg, name))
typedef int (*Bounds)(uint32_t,uint32_t,CGRect *);
typedef int (*Move)(uint32_t,uint32_t,const CGPoint *);
typedef int (*Pair)(uint32_t,uint32_t,uint32_t);
typedef int (*Order)(uint32_t,uint32_t,int,uint32_t);
static NSDictionary *rect(CGRect r) { return @{@"x":@(r.origin.x),@"y":@(r.origin.y),@"width":@(r.size.width),@"height":@(r.size.height)}; }
static CGRect bounds(uint32_t wid) {
    CGRect value=CGRectZero;
    int result=SKY("SLSGetWindowBounds",Bounds)(cid,wid,&value);
    if(result!=0 || value.size.width<=0 || value.size.height<=0)
        emit(@{@"stage":@"bounds-failure",@"window":@(wid),@"result":@(result),@"rect":rect(value)});
    require(result==0 && value.size.width>0 && value.size.height>0,@"private bounds unavailable");
    return value;
}
static void pump(double seconds) {
    NSDate *end=[NSDate dateWithTimeIntervalSinceNow:seconds];
    while(end.timeIntervalSinceNow>0) {
        NSEvent *event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.002] inMode:NSDefaultRunLoopMode dequeue:YES];
        if(event) [NSApp sendEvent:event];
    }
}
static void writeJSON(NSString *name,NSDictionary *value) {
    require([[NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil]
        writeToFile:[root stringByAppendingPathComponent:name] atomically:YES],@"owned IPC write failed");
}
static NSDictionary *readJSON(NSString *name) {
    NSData *data=[NSData dataWithContentsOfFile:[root stringByAppendingPathComponent:name]];
    return data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
}
static NSDictionary *waitJSON(NSString *name,NSNumber *serial) {
    NSDate *end=[NSDate dateWithTimeIntervalSinceNow:3];
    do {
        NSDictionary *row=readJSON(name);
        if(row && (!serial || [row[@"serial"] isEqual:serial])) return row;
        pump(0.005);
    } while(end.timeIntervalSinceNow>0);
    require(NO,[@"timed out waiting for " stringByAppendingString:name]); return nil;
}
static NSDictionary *command(NSString *name) {
    static unsigned sequence=0; NSNumber *serial=@(++sequence);
    writeJSON(@"command.json",@{@"serial":serial,@"command":name});
    return waitJSON(@"ack.json",serial);
}
static NSButton *button(NSWindow *window,NSUInteger kind) {
    SEL selector=NSSelectorFromString(@"_findStandardWindowButton:");
    Method method=class_getInstanceMethod(window.class,selector);
    require(method && !strcmp(method_getTypeEncoding(method),"@24@0:8Q16"),@"button lookup ABI differs");
    return ((id(*)(id,SEL,NSUInteger))method_getImplementation(method))(window,selector,kind);
}
static void hidden(NSButton *view,BOOL value) {
    SEL selector=NSSelectorFromString(@"_setHidden:setNeedsDisplay:");
    Method method=class_getInstanceMethod(view.class,selector);
    require(method && !strcmp(method_getTypeEncoding(method),"v24@0:8B16B20"),@"hide ABI differs");
    ((void(*)(id,SEL,BOOL,BOOL))method_getImplementation(method))(view,selector,value,YES);
}
static NSDictionary *region(uint32_t wid) {
    typedef void *(*Get)(uint32_t); typedef int (*GetBounds)(void *,CGRect *);
    void *value=SKY("SLSGetButtonRegionLegacy",Get)(wid); CGRect r=CGRectZero;
    if(!value) return @{@"present":@NO};
    int result=CG("CGSGetRegionBounds",GetBounds)(value,&r);
    return @{@"present":@YES,@"result":@(result),@"rect":rect(r)};
}
static void transactionGroup(uint32_t leader,uint32_t member,BOOL add) {
    typedef CFTypeRef (*Create)(uint32_t);typedef void (*Set)(CFTypeRef,uint32_t,uint32_t);typedef void (*Commit)(CFTypeRef,int);
    CFTypeRef tx=SKY("SLSTransactionCreate",Create)(cid);require(tx!=NULL,@"group transaction creation failed");
    SKY(add?"SLSTransactionAddWindowToWindowMovementGroup":"SLSTransactionRemoveWindowFromWindowMovementGroup",Set)(tx,leader,member);
    SKY("SLSTransactionCommit",Commit)(tx,1);CFRelease(tx);
}
static uint32_t surface(CGRect r) {
    typedef int (*Region)(CGRect *,void **); typedef void (*Free)(void *);
    typedef int (*New)(uint32_t,int,float,float,void *,uint32_t *);
    typedef CGContextRef (*Context)(uint32_t,uint32_t,CFDictionaryRef);
    typedef int (*Tags)(uint32_t,uint32_t,uint64_t *,int);
    typedef int (*Opaque)(uint32_t,uint32_t,bool);
    typedef int (*Flush)(uint32_t,uint32_t,void *);
    CGRect local=(CGRect){CGPointZero,r.size}; void *shape=NULL; uint32_t wid=0;
    require(CG("CGSNewRegionWithRect",Region)(&local,&shape)==0 && shape,@"surface region failed");
    int result=SKY("SLSNewWindow",New)(cid,2,r.origin.x,r.origin.y,shape,&wid);
    CG("CGRegionRelease",Free)(shape);
    require(result==0 && wid,@"surface creation failed"); [owned addObject:@(wid)];
    uint64_t tags=(1ull<<3)|(1ull<<10)|(1ull<<15)|(1ull<<16)|(1ull<<18);
    require(SKY("SLSSetWindowTags",Tags)(cid,wid,&tags,64)==0,@"surface tags failed");
    require(SKY("SLSSetWindowOpacity",Opaque)(cid,wid,true)==0,@"surface opacity failed");
    CGContextRef context=SKY("SLWindowContextCreate",Context)(cid,wid,NULL);
    require(context!=NULL,@"surface context failed");
    CGContextSetRGBFillColor(context,0.12,0.14,0.18,1); CGContextFillRect(context,local); CGContextFlush(context);
    require(SKY("SLSFlushWindowContentRegion",Flush)(cid,wid,NULL)==0,@"surface flush failed");
    CGContextRelease(context); return wid;
}
static void notice(uint32_t event,void *data,size_t length,void *context) {
    (void)context; uint32_t wid=0; if(length>=4 && data) memcpy(&wid,data,4);
    [noticeLock lock]; [notices addObject:@{@"event":@(event),@"payloadPrefix":@(wid),@"bytes":@(length),@"uptime":@(NSProcessInfo.processInfo.systemUptime)}];
    BOOL matches=length==4 && wid==trackedTarget && (event==806 || event==807);[noticeLock unlock];
    if(matches)
        dispatch_async(dispatch_get_main_queue(),^{ if(tracking) tracking(event); });
}
static void runChild(void) {
    NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(260,230,620,400)
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO; window.title=@"Disposable no-AX tracking fixture";
    window.contentView.wantsLayer=YES; window.contentView.layer.backgroundColor=NSColor.systemTealColor.CGColor;
    NSTextField *label=[NSTextField labelWithString:@"No Accessibility permission\nOnly this disposable window is changed"];
    label.font=[NSFont systemFontOfSize:22]; label.frame=NSMakeRect(30,210,560,80); [window.contentView addSubview:label];
    [window makeKeyAndOrderFront:nil]; [NSApp activate]; pump(0.2);
    uint32_t wid=(uint32_t)window.windowNumber;
    void (^truth)(NSString *)=^(NSString *phase){
        NSMutableArray *buttons=NSMutableArray.array;
        for(NSUInteger i=0;i<3;i++) {
            NSButton *b=button(window,i); CGRect frame=[b convertRect:b.bounds toView:nil];
            [buttons addObject:@{@"kind":@(i),@"hidden":@(b.hiddenOrHasHiddenAncestor),@"alpha":@(b.alphaValue),@"enabled":@(b.enabled),@"windowRect":rect(frame)}];
        }
        writeJSON([@"truth-" stringByAppendingString:[phase stringByAppendingString:@".json"]],
            @{@"phase":phase,@"window":@(wid),@"buttons":buttons,@"appKitFrame":rect(window.frame),@"serverBounds":rect(bounds(wid)),@"region":region(wid),@"windowed":@(!(window.styleMask&NSWindowStyleMaskFullScreen))});
    };
    truth(@"baseline");
    // Bootstrap identity only. Button rectangles/visibility are written solely
    // to truth files for the independent verifier, never read by the controller.
    writeJSON(@"ready.json",@{@"window":@(wid),@"pid":@(getpid()),@"connection":@(cid)});
    NSNumber *last=@0;
    for(;;) {
        pump(0.005); NSDictionary *request=readJSON(@"command.json");
        if(!request || [request[@"serial"] isEqual:last]) continue;
        last=request[@"serial"]; NSString *name=request[@"command"];
        if([name isEqual:@"quit"]) { [window close]; writeJSON(@"ack.json",@{@"serial":last}); exit(0); }
        if([name isEqual:@"move"]) [window setFrameOrigin:NSMakePoint(window.frame.origin.x+130,window.frame.origin.y+45)];
        else if([name isEqual:@"resize"]) [window setContentSize:NSMakeSize(700,440)];
        else if([name isEqual:@"reset"]) [window setFrameOrigin:NSMakePoint(260,230)];
        else if([name isEqual:@"activate"]) { [window makeKeyAndOrderFront:nil];[NSApp activate]; }
        else if([name isEqual:@"sweep"]) {
            // Owned motion stimulus only. The controller never receives these
            // positions; it reacts solely to private WindowServer notifications.
            for(int i=0;i<120;i++) {
                double phase=(double)i/119.0;
                [window setFrameOrigin:NSMakePoint(260+65-65*cos(phase*16*M_PI),230+45*sin(phase*2*M_PI))];
                pump(1.0/60.0);
            }
        }
        else if([name isEqual:@"hidden"] || [name isEqual:@"shown"])
            for(NSUInteger i=0;i<3;i++) hidden(button(window,i),[name isEqual:@"hidden"]);
        else require(NO,@"unknown child command");
        [window displayIfNeeded]; pump(0.15); truth(name);
        writeJSON(@"ack.json",@{@"serial":last});
    }
}
static void captureCheckpoint(NSString *phase,CGRect canvas) {
    writeJSON(@"capture-request.json",@{@"phase":phase,@"rect":rect(canvas)});
    NSDictionary *ack=waitJSON(@"capture-done.json",nil);
    NSDate *end=[NSDate dateWithTimeIntervalSinceNow:6];
    while(![ack[@"phase"] isEqual:phase] && end.timeIntervalSinceNow>0) { pump(0.005); ack=readJSON(@"capture-done.json"); }
    require([ack[@"phase"] isEqual:phase] && [ack[@"ok"] boolValue],@"measurement checkpoint failed");
}
static void runController(BOOL captures,BOOL followEvents,BOOL transactionGroups) {
    child=NSTask.new; child.executableURL=NSBundle.mainBundle.executableURL;
    child.arguments=@[@"--child",root]; child.standardOutput=NSFileHandle.fileHandleWithStandardOutput;
    require([child launchAndReturnError:nil],@"child launch failed");
    NSDictionary *ready=waitJSON(@"ready.json",nil); uint32_t target=[ready[@"window"] unsignedIntValue];
    typedef int (*Owner)(uint32_t,uint32_t,uint32_t *); typedef int (*PID)(uint32_t,pid_t *);
    uint32_t owner=0;pid_t pid=0;
    require(SKY("SLSGetWindowOwner",Owner)(cid,target,&owner)==0 && SKY("SLSConnectionGetPID",PID)(owner,&pid)==0 && pid==child.processIdentifier && owner!=cid,@"foreign child identity mismatch");
    typedef int (*Request)(uint32_t,uint32_t *,int);
    emit(@{@"stage":@"request-window-notifications",@"result":@(SKY("SLSRequestNotificationsForWindows",Request)(cid,&target,1))});
    AXUIElementRef app=AXUIElementCreateApplication(pid); CFTypeRef value=NULL;
    AXError ax=AXUIElementCopyAttributeValue(app,kAXWindowsAttribute,&value); if(value) CFRelease(value); CFRelease(app);
    emit(@{@"stage":@"permission-negative-control",@"AXTrusted":@(AXIsProcessTrusted()),@"AXWindowsResult":@(ax),@"childPID":@(pid),@"targetWindow":@(target)});
    require(!AXIsProcessTrusted() && ax!=kAXErrorSuccess,@"AX negative control unexpectedly succeeded");
    CGRect original=bounds(target);
    CGRect canvas=CGRectInset(CGRectUnion(original,CGRectOffset(original,160,-70)),-24,-24);
    CGFloat desktopHeight=CGDisplayBounds(CGMainDisplayID()).size.height;
    NSRect backdropFrame=NSMakeRect(canvas.origin.x,desktopHeight-CGRectGetMaxY(canvas),canvas.size.width,canvas.size.height);
    NSWindow *backdrop=[[NSWindow alloc] initWithContentRect:backdropFrame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    backdrop.releasedWhenClosed=NO;backdrop.backgroundColor=[NSColor colorWithCalibratedWhite:0.3 alpha:1];backdrop.ignoresMouseEvents=YES;
    [backdrop orderBack:nil];
    require(SKY("SLSOrderWindow",Order)(cid,(uint32_t)backdrop.windowNumber,-1,target)==0,@"owned backdrop ordering failed");pump(0.15);
    if(captures)captureCheckpoint(@"baseline",canvas);
    // A local AppKit template calibrates a known layout. This is deliberately
    // labelled calibration, not a discovered foreign button/visibility signal.
    NSWindow *template=[[NSWindow alloc] initWithContentRect:NSMakeRect(-3000,-3000,620,400)
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    template.releasedWhenClosed=NO; [template orderBack:nil]; [template displayIfNeeded];pump(0.08);
    CGRect local=CGRectNull;
    for(NSUInteger i=0;i<3;i++) { NSButton *b=button(template,i); CGRect f=[b convertRect:b.bounds toView:nil]; f.origin.y=template.frame.size.height-CGRectGetMaxY(f); local=CGRectUnion(local,f); }
    local=CGRectInset(local,-2,-2);
    emit(@{@"stage":@"foreign-metadata",@"bounds":rect(original),@"region":region(target),@"placement":@"local AppKit template only",@"calibratedLocalRect":rect(local)});
    Class cls=NSClassFromString(@"NSCGSWindow"); SEL selector=NSSelectorFromString(@"windowWithWindowID:"); Method method=class_getClassMethod(cls,selector);
    id proxy=nil;
    if(method && !strcmp(method_getTypeEncoding(method),"@20@0:8I16")) proxy=((id(*)(id,SEL,uint32_t))method_getImplementation(method))(cls,selector,target);
    emit(@{@"stage":@"foreign-metadata-after-proxy",@"retainedProxy":@(proxy!=nil),@"region":region(target)});
    CGRect tf=bounds((uint32_t)template.windowNumber); CGRect markerRect=CGRectMake(tf.origin.x+10,tf.origin.y+10,local.size.width,local.size.height);
    uint32_t marker=surface(markerRect); uint32_t templateID=(uint32_t)template.windowNumber;
    int joined=SKY("SLSAddWindowToWindowMovementGroup",Pair)(cid,templateID,marker);
    CGPoint moved=CGPointMake(tf.origin.x+40,tf.origin.y+20);
    require(SKY("SLSMoveWindowWithGroup",Move)(cid,templateID,&moved)==0,@"owned move failed");pump(0.15);
    CGRect markerAfter=bounds(marker);
    BOOL positive=fabs(markerAfter.origin.x-markerRect.origin.x-40)<1 && fabs(markerAfter.origin.y-markerRect.origin.y-20)<1;
    emit(@{@"stage":@"owned-group-control",@"joinResult":@(joined),@"memberBefore":rect(markerRect),@"memberAfter":rect(markerAfter),@"follows":@(positive)});
    require(joined==0 && positive,@"owned movement-group positive control failed");
    require(SKY("SLSRemoveWindowFromWindowMovementGroup",Pair)(cid,templateID,marker)==0,@"owned group removal failed");
    if(transactionGroups) {
        transactionGroup(templateID,marker,YES);
        CGPoint again=CGPointMake(moved.x+40,moved.y+20);
        require(SKY("SLSMoveWindowWithGroup",Move)(cid,templateID,&again)==0,@"owned transaction-group move failed");pump(0.15);
        CGRect second=bounds(marker);
        BOOL txPositive=fabs(second.origin.x-markerAfter.origin.x-40)<1 && fabs(second.origin.y-markerAfter.origin.y-20)<1;
        emit(@{@"stage":@"owned-transaction-group-control",@"follows":@(txPositive),@"before":rect(markerAfter),@"after":rect(second)});
        require(txPositive,@"owned transaction-group positive control failed");
        transactionGroup(templateID,marker,NO);
    }
    [template close];
    CGRect patchRect=CGRectOffset(local,original.origin.x,original.origin.y);
    CGPoint initial=patchRect.origin; require(SKY("SLSMoveWindow",Move)(cid,marker,&initial)==0,@"patch move failed");
    int foreignJoin=SKY("SLSAddWindowToWindowMovementGroup",Pair)(cid,target,marker);
    if(transactionGroups)transactionGroup(target,marker,YES);
    require(SKY("SLSOrderWindow",Order)(cid,marker,1,target)==0,@"patch ordering failed");pump(0.15);
    emit(@{@"stage":@"cover-shown",@"targetWindow":@(target),@"coverWindow":@(marker),@"foreignJoinResult":@(foreignJoin),@"target":rect(original),@"cover":rect(bounds(marker))});
    if(captures)captureCheckpoint(@"covered",canvas);
    command(@"move");CGRect targetAfter=bounds(target),patchAfter=bounds(marker);
    double dx=targetAfter.origin.x-original.origin.x,dy=targetAfter.origin.y-original.origin.y;
    BOOL follows=fabs(patchAfter.origin.x-patchRect.origin.x-dx)<1 && fabs(patchAfter.origin.y-patchRect.origin.y-dy)<1;
    emit(@{@"stage":@"foreign-group-move",@"joinResult":@(foreignJoin),@"transactionAttempted":@(transactionGroups),@"target":rect(targetAfter),@"cover":rect(patchAfter),@"dx":@(dx),@"dy":@(dy),@"followsWithoutControllerMoves":@(follows)});
    if(captures)captureCheckpoint(@"moved",canvas);
    if(transactionGroups && follows) {
        command(@"reset");
        if(captures)captureCheckpoint(@"grouped-motion",canvas);
        command(@"sweep");pump(3.0);
    }
    // Once a candidate fails, withdraw it. Metadata tests below are independent
    // observations, not retries of the movement strategy or hidden-state claims.
    SKY("SLSOrderWindow",Order)(cid,marker,0,0);
    if(foreignJoin==0) SKY("SLSRemoveWindowFromWindowMovementGroup",Pair)(cid,target,marker);
    if(transactionGroups)transactionGroup(target,marker,NO);
    if(followEvents) {
        command(@"reset");
        [noticeLock lock];trackedTarget=target;[noticeLock unlock];
        tracking=^(uint32_t event){
            CGRect live=bounds(target);CGPoint point=CGPointMake(live.origin.x+local.origin.x,live.origin.y+local.origin.y);
            require(SKY("SLSMoveWindow",Move)(cid,marker,&point)==0,@"notification cover move failed");
            emit(@{@"stage":@"tracking-update",@"event":@(event),@"target":rect(live),@"cover":rect(bounds(marker)),@"uptime":@(NSProcessInfo.processInfo.systemUptime)});
        };
        tracking(0);require(SKY("SLSOrderWindow",Order)(cid,marker,1,target)==0,@"tracking cover ordering failed");
        if(captures)captureCheckpoint(@"tracked-covered",canvas);
        command(@"move");
        CGRect current=bounds(target),cover=bounds(marker);
        require(fabs(cover.origin.x-current.origin.x-local.origin.x)<1 && fabs(cover.origin.y-current.origin.y-local.origin.y)<1,@"notification tracking did not follow move");
        emit(@{@"stage":@"tracked-move",@"target":rect(current),@"cover":rect(cover)});
        if(captures)captureCheckpoint(@"tracked-moved",canvas);
        command(@"resize");
        current=bounds(target);cover=bounds(marker);
        require(fabs(cover.origin.x-current.origin.x-local.origin.x)<1 && fabs(cover.origin.y-current.origin.y-local.origin.y)<1,@"notification tracking did not follow resize");
        emit(@{@"stage":@"tracked-resize",@"target":rect(current),@"cover":rect(cover)});
        if(captures)captureCheckpoint(@"tracked-resized",canvas);
        command(@"reset");
        if(captures)captureCheckpoint(@"tracked-motion",canvas);
        command(@"sweep");
        // Let the independent recorder finish before later native hide/show.
        pump(3.0);tracking=nil;[noticeLock lock];trackedTarget=0;[noticeLock unlock];
        SKY("SLSOrderWindow",Order)(cid,marker,0,0);
    }
    emit(@{@"stage":@"metadata-before-hide",@"region":region(target)});
    command(@"hidden");emit(@{@"stage":@"metadata-while-hidden",@"region":region(target)});
    command(@"shown");emit(@{@"stage":@"metadata-while-shown",@"region":region(target)});
    command(@"resize");emit(@{@"stage":@"metadata-after-resize",@"bounds":rect(bounds(target)),@"region":region(target)});
    pump(0.1);[noticeLock lock];NSArray *events=notices.copy;[noticeLock unlock];
    writeJSON(@"notifications.json",@{@"events":events});
    emit(@{@"stage":@"notifications",@"count":@(events.count)});
    command(@"quit");[child waitUntilExit];
    [backdrop close];(void)proxy;finish(0,@"bounded no-AX observations complete; no universal visibility or flicker-free claim");
}
int main(int argc,const char **argv) {
    @autoreleasepool {
        setbuf(stdout,NULL);
        BOOL controller=argc>=3 && !strcmp(argv[1],"--run"),isChild=argc==3 && !strcmp(argv[1],"--child");
        if(!controller && !isChild) { emit(@{@"plan":@"New no-AX app identity; require AXTrusted=false. One owned child, private bounds/region/notifications, calibrated opaque cover, owned/foreign movement-group controls, native hide/show metadata comparison. --track-events follows private move/resize callbacks and adds a bounded fast sweep. No browser/user window changed. --run ROOT [--capture-checkpoints] [--track-events]; --child internal only."});return 0; }
        root=@(argv[2]);require([root containsString:@"/test-results/traffic-lights-no-ax-"] && [NSFileManager.defaultManager fileExistsAtPath:[root stringByAppendingPathComponent:@".owned-fixture"]],@"not an owned fixture");
        char build[32]={0};size_t length=sizeof(build);require(!sysctlbyname("kern.osversion",build,&length,NULL,0) && !strcmp(build,"25G342"),@"requires 25G342");
        alarm(40);owned=NSMutableArray.array;notices=NSMutableArray.array;noticeLock=NSLock.new;
        [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];[NSApp finishLaunching];
        sky=dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",RTLD_NOW);cg=dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",RTLD_NOW);
        require(sky && cg,@"framework load failed");cid=SKY("SLSMainConnectionID",uint32_t(*)(void))();
        emit(@{@"stage":@"identity",@"pid":@(getpid()),@"parentPID":@(getppid()),@"connection":@(cid),@"AXTrusted":@(AXIsProcessTrusted()),@"role":isChild?@"child":@"controller",@"bundleIdentifier":NSBundle.mainBundle.bundleIdentifier?:@""});
        require(!AXIsProcessTrusted(),@"identity already has AX permission");
        if(isChild)runChild();
        typedef int (*Register)(void *,uint32_t,void *);
        for(NSNumber *event in @[@804,@806,@807,@808,@815,@816,@723])
            emit(@{@"stage":@"register-notification",@"event":event,@"result":@(SKY("SLSRegisterNotifyProc",Register)((void *)notice,event.unsignedIntValue,NULL))});
        BOOL captures=NO,followEvents=NO,transactionGroups=NO;
        for(int i=3;i<argc;i++) { if(!strcmp(argv[i],"--capture-checkpoints"))captures=YES;if(!strcmp(argv[i],"--track-events"))followEvents=YES;if(!strcmp(argv[i],"--transaction-groups"))transactionGroups=YES; }
        require(!(followEvents && transactionGroups),@"separate tracking hypotheses into distinct runs");
        runController(captures,followEvents,transactionGroups);
    }
    return 0;
}
