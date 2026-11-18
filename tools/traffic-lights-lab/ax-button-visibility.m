// Metadata-only research. No capture API, image analysis, permission request or
// write to an existing user app. Only disposable fixture/browser state changes.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <objc/runtime.h>
#include <dlfcn.h>
#include <sys/sysctl.h>
#include <unistd.h>

static NSString *root;
static NSTask *child;
static NSRunningApplication *previous;
static NSMutableArray *notifications;
static void emit(NSDictionary *row) {
    puts([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:row options:NSJSONWritingSortedKeys error:nil] encoding:NSUTF8StringEncoding].UTF8String);
}
static void finish(int code,NSString *reason) {
    if(child.running){[child terminate];[child waitUntilExit];}
    if(previous)[previous activateWithOptions:0];
    emit(@{@"complete":@YES,@"status":@(code),@"reason":reason,@"screenCaptureUsed":@NO,@"childExited":@(!child.running)});exit(code);
}
static void require(BOOL condition,NSString *reason){if(!condition)finish(2,reason);}
static void pump(double seconds){
    NSDate *until=[NSDate dateWithTimeIntervalSinceNow:seconds];
    while(until.timeIntervalSinceNow>0){NSEvent *event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.003] inMode:NSDefaultRunLoopMode dequeue:YES];if(event)[NSApp sendEvent:event];}
}
static void save(NSString *file,NSDictionary *row){
    require([[NSJSONSerialization dataWithJSONObject:row options:NSJSONWritingSortedKeys error:nil] writeToFile:[root stringByAppendingPathComponent:file] atomically:YES],@"owned metadata write failed");
}
static NSDictionary *load(NSString *file){NSData *data=[NSData dataWithContentsOfFile:[root stringByAppendingPathComponent:file]];return data?[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]:nil;}
static NSDictionary *awaitSerial(NSString *file,NSNumber *serial){
    NSDate *end=[NSDate dateWithTimeIntervalSinceNow:12];
    do{NSDictionary *row=load(file);if(row&&(!serial||[row[@"serial"] isEqual:serial]))return row;pump(0.005);}while(end.timeIntervalSinceNow>0);
    require(NO,[@"metadata IPC timeout: " stringByAppendingString:file]);return nil;
}
static NSButton *nativeButton(NSWindow *window,NSUInteger kind){
    SEL s=NSSelectorFromString(@"_findStandardWindowButton:");Method m=class_getInstanceMethod(window.class,s);
    require(m&&!strcmp(method_getTypeEncoding(m),"@24@0:8Q16"),@"button lookup ABI differs");
    return ((id(*)(id,SEL,NSUInteger))method_getImplementation(m))(window,s,kind);
}
static void hide(NSView *view,BOOL value){
    SEL s=NSSelectorFromString(@"_setHidden:setNeedsDisplay:");Method m=class_getInstanceMethod(view.class,s);
    require(m&&!strcmp(method_getTypeEncoding(m),"v24@0:8B16B20"),@"hide ABI differs");
    ((void(*)(id,SEL,BOOL,BOOL))method_getImplementation(m))(view,s,value,YES);
}
static double reveal(NSButton *button,NSNumber *set){
    SEL s=NSSelectorFromString(set?@"setRevealAmount:":@"revealAmount");Method m=class_getInstanceMethod(button.class,s);
    const char *expected=set?"v24@0:8d16":"d16@0:8";
    require(m&&!strcmp(method_getTypeEncoding(m),expected),@"widget reveal ABI differs");
    if(set){((void(*)(id,SEL,double))method_getImplementation(m))(button,s,set.doubleValue);return set.doubleValue;}
    return ((double(*)(id,SEL))method_getImplementation(m))(button,s);
}
static NSDictionary *nativeTruth(NSWindow *window){
    NSMutableArray *buttons=NSMutableArray.array;
    for(NSUInteger i=0;i<3;i++){
        NSButton *b=nativeButton(window,i);NSRect r=[b convertRect:b.bounds toView:nil];
        [buttons addObject:@{@"kind":@(i),@"class":NSStringFromClass(b.class),@"hidden":@(b.hiddenOrHasHiddenAncestor),
            @"alpha":@(b.alphaValue),@"enabled":@(b.enabled),@"reveal":@(reveal(b,nil)),
            @"localFrame":@[@(r.origin.x),@(r.origin.y),@(r.size.width),@(r.size.height)],
            @"nativeHit":@([b.superview hitTest:NSMakePoint(NSMidX(b.frame),NSMidY(b.frame))]==b)}];
    }
    return @{@"buttons":buttons,@"window":@(window.windowNumber),@"fullscreen":@((window.styleMask&NSWindowStyleMaskFullScreen)!=0),@"active":@(NSApp.active),@"key":@(window.keyWindow)};
}
static void fullscreen(NSWindow *window,BOOL enter){
    if(((window.styleMask&NSWindowStyleMaskFullScreen)!=0)==enter)return;
    __block BOOL completed=NO;
    id token=[NSNotificationCenter.defaultCenter addObserverForName:enter?NSWindowDidEnterFullScreenNotification:NSWindowDidExitFullScreenNotification object:window queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note){(void)note;completed=YES;}];
    [window toggleFullScreen:nil];NSDate *end=[NSDate dateWithTimeIntervalSinceNow:8];
    while(!completed&&end.timeIntervalSinceNow>0)pump(0.02);
    [NSNotificationCenter.defaultCenter removeObserver:token];
    require(completed,@"owned fullscreen transition did not complete");pump(1.0);
}
static void fixture(void){
    NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(260,230,640,400) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;window.title=@"Metadata-only button visibility fixture";
    window.collectionBehavior=NSWindowCollectionBehaviorFullScreenPrimary;
    NSTextField *label=[NSTextField labelWithString:@"Accessibility metadata test\nNo screen or window capture"];
    label.font=[NSFont systemFontOfSize:22];label.frame=NSMakeRect(35,230,570,80);[window.contentView addSubview:label];
    [window makeKeyAndOrderFront:nil];[NSApp activate];pump(0.3);
    save(@"ready.json",@{@"pid":@(getpid()),@"window":@(window.windowNumber)});
    NSNumber *last=@0;NSString *current=@"initial";
    for(;;){
        pump(0.005);NSDictionary *request=load(@"command.json");if(!request||[request[@"serial"] isEqual:last])continue;
        last=request[@"serial"];NSString *name=request[@"phase"];
        if([name isEqual:@"sampled"]){save([@"truth-post-" stringByAppendingString:[current stringByAppendingString:@".json"]],nativeTruth(window));}
        else if([name isEqual:@"quit"]){fullscreen(window,NO);[window close];save(@"ack.json",@{@"serial":last,@"window":@(window.windowNumber)});exit(0);}
        else{
            current=name;
            BOOL enter=[name isEqual:@"fullscreen"];
            fullscreen(window,enter);
            if(!enter)for(NSUInteger i=0;i<3;i++){NSButton *b=nativeButton(window,i);hide(b.superview,NO);hide(b,NO);b.alphaValue=1;b.enabled=YES;reveal(b,@1);}
            if([name isEqual:@"hidden"])for(NSUInteger i=0;i<3;i++)hide(nativeButton(window,i),YES);
            else if([name isEqual:@"disabled"])for(NSUInteger i=0;i<3;i++)nativeButton(window,i).enabled=NO;
            else if([name isEqual:@"alpha-zero"])for(NSUInteger i=0;i<3;i++)nativeButton(window,i).alphaValue=0;
            else if([name isEqual:@"reveal-zero"])for(NSUInteger i=0;i<3;i++)reveal(nativeButton(window,i),@0);
            else if([name isEqual:@"reveal-half"])for(NSUInteger i=0;i<3;i++)reveal(nativeButton(window,i),@0.5);
            else if([name isEqual:@"only-close"])for(NSUInteger i=1;i<3;i++)hide(nativeButton(window,i),YES);
            else if([name isEqual:@"ancestor-hidden"])hide(nativeButton(window,0).superview,YES);
            else if(![name isEqual:@"shown"]&&![name isEqual:@"restored"]&&![name isEqual:@"post-fullscreen"]&&!enter)require(NO,@"unknown fixture phase");
            [window displayIfNeeded];pump(0.25);
            save([@"truth-pre-" stringByAppendingString:[name stringByAppendingString:@".json"]],nativeTruth(window));
        }
        save(@"ack.json",@{@"serial":last,@"window":@(window.windowNumber)});
    }
}
static AXError axRead(AXUIElementRef element,NSString *key,CFTypeRef *value){return AXUIElementCopyAttributeValue(element,(__bridge CFStringRef)key,value);}
static id valueJSON(CFTypeRef value){
    if(!value)return NSNull.null;
    if(CFGetTypeID(value)==AXValueGetTypeID()){
        AXValueRef a=(AXValueRef)value;
        if(AXValueGetType(a)==kAXValueCGPointType){CGPoint p;AXValueGetValue(a,kAXValueCGPointType,&p);return @[@(p.x),@(p.y)];}
        if(AXValueGetType(a)==kAXValueCGSizeType){CGSize s;AXValueGetValue(a,kAXValueCGSizeType,&s);return @[@(s.width),@(s.height)];}
        if(AXValueGetType(a)==kAXValueCGRectType){CGRect r;AXValueGetValue(a,kAXValueCGRectType,&r);return @[@(r.origin.x),@(r.origin.y),@(r.size.width),@(r.size.height)];}
    }
    if(CFGetTypeID(value)==CFBooleanGetTypeID()||CFGetTypeID(value)==CFNumberGetTypeID()||CFGetTypeID(value)==CFStringGetTypeID())return (__bridge id)value;
    return @{@"typeID":@(CFGetTypeID(value))};
}
static NSDictionary *attribute(AXUIElementRef element,NSString *key){
    CFTypeRef value=NULL;AXError result=axRead(element,key,&value);id json=valueJSON(value);if(value)CFRelease(value);
    return @{@"error":@(result),@"value":json};
}
static NSArray *displayRects(void){
    CGDirectDisplayID displays[32];uint32_t count=0;NSMutableArray *rows=NSMutableArray.array;
    require(CGGetActiveDisplayList(32,displays,&count)==kCGErrorSuccess,@"display metadata unavailable");
    for(uint32_t i=0;i<count;i++){CGRect r=CGDisplayBounds(displays[i]);[rows addObject:@[@(r.origin.x),@(r.origin.y),@(r.size.width),@(r.size.height)]];}
    return rows;
}
static BOOL member(CFArrayRef list,AXUIElementRef element){
    if(!list||!element)return NO;for(CFIndex i=0;i<CFArrayGetCount(list);i++)if(CFEqual(CFArrayGetValueAtIndex(list,i),element))return YES;return NO;
}
typedef AXError (*AXWindowID)(AXUIElementRef,uint32_t *);
static AXWindowID getWindowID;
static AXUIElementRef exactWindow(AXUIElementRef app,uint32_t wid){
    CFTypeRef windows=NULL;AXError result=axRead(app,@"AXWindows",&windows);require(result==kAXErrorSuccess&&windows&&CFGetTypeID(windows)==CFArrayGetTypeID(),@"fixture AX windows unavailable");
    AXUIElementRef found=NULL;
    for(id item in (__bridge NSArray *)windows){uint32_t number=0;AXUIElementRef w=(__bridge AXUIElementRef)item;if(getWindowID(w,&number)==kAXErrorSuccess&&number==wid){found=(AXUIElementRef)CFRetain(w);break;}}
    CFRelease(windows);require(found!=NULL,@"exact fixture AX window missing");return found;
}
static NSArray *sample(AXUIElementRef app,AXUIElementRef window){
    NSMutableArray *rows=NSMutableArray.array;CFTypeRef children=NULL,visible=NULL;
    AXUIElementRef zoom=NULL;
    AXError ce=axRead(window,@"AXChildren",&children),ve=axRead(window,@"AXVisibleChildren",&visible);
    for(NSString *key in @[@"AXCloseButton",@"AXMinimizeButton",@"AXZoomButton",@"AXFullScreenButton"]){
        CFTypeRef reference=NULL;AXError result=axRead(window,key,&reference);
        NSMutableDictionary *row=[@{@"relationship":key,@"referenceError":@(result),@"childrenError":@(ce),@"visibleChildrenError":@(ve)} mutableCopy];
        if(result==kAXErrorSuccess&&reference&&CFGetTypeID(reference)==AXUIElementGetTypeID()){
            AXUIElementRef button=(AXUIElementRef)reference;NSMutableDictionary *values=NSMutableDictionary.dictionary;
            CFArrayRef names=NULL;AXError namesResult=AXUIElementCopyAttributeNames(button,&names);
            row[@"attributeNamesError"]=@(namesResult);if(names){row[@"attributeNames"]=(__bridge NSArray *)names;CFRelease(names);}
            if([key isEqual:@"AXZoomButton"])zoom=(AXUIElementRef)CFRetain(button);
            if([key isEqual:@"AXFullScreenButton"])row[@"sameAsZoomReference"]=@(zoom&&CFEqual(zoom,button));
            for(NSString *name in @[@"AXRole",@"AXSubrole",@"AXEnabled",@"AXHidden",@"AXVisible",@"AXPosition",@"AXSize",@"AXFrame",@"AXFocused"])
                values[name]=attribute(button,name);
            row[@"attributes"]=values;
            row[@"inChildren"]=@(ce==0&&children&&CFGetTypeID(children)==CFArrayGetTypeID()&&member((CFArrayRef)children,button));
            row[@"inVisibleChildren"]=@(ve==0&&visible&&CFGetTypeID(visible)==CFArrayGetTypeID()&&member((CFArrayRef)visible,button));
            CFTypeRef p=NULL,s=NULL;
            if(axRead(button,@"AXPosition",&p)==0&&axRead(button,@"AXSize",&s)==0&&p&&s&&CFGetTypeID(p)==AXValueGetTypeID()&&CFGetTypeID(s)==AXValueGetTypeID()){
                CGPoint point;CGSize size;
                if(AXValueGetValue((AXValueRef)p,kAXValueCGPointType,&point)&&AXValueGetValue((AXValueRef)s,kAXValueCGSizeType,&size)){
                    AXUIElementRef hit=NULL;
                    AXError he=AXUIElementCopyElementAtPosition(app,point.x+size.width/2,point.y+size.height/2,&hit);
                    row[@"hitError"]=@(he);row[@"hitMatches"]=@(hit&&CFEqual(hit,button));
                    if(hit){row[@"hitRole"]=attribute(hit,@"AXRole");row[@"hitSubrole"]=attribute(hit,@"AXSubrole");CFRelease(hit);}
                }
            }
            if(p)CFRelease(p);if(s)CFRelease(s);
        }
        if(reference)CFRelease(reference);[rows addObject:row];
    }
    if(zoom)CFRelease(zoom);if(children)CFRelease(children);if(visible)CFRelease(visible);return rows;
}
static void occlusionCheck(AXUIElementRef app,AXUIElementRef window,uint32_t target){
    CGRect box=CGRectNull;
    for(NSDictionary *row in sample(app,window)){
        NSDictionary *a=row[@"attributes"];NSArray *p=a[@"AXPosition"][@"value"],*s=a[@"AXSize"][@"value"];
        if([p isKindOfClass:NSArray.class]&&[s isKindOfClass:NSArray.class])box=CGRectUnion(box,CGRectMake([p[0] doubleValue],[p[1] doubleValue],[s[0] doubleValue],[s[1] doubleValue]));
    }
    require(!CGRectIsNull(box)&&box.size.width<150&&box.size.height<50,@"unexpected owned occluder box");
    CGFloat h=CGDisplayBounds(CGMainDisplayID()).size.height;
    NSPanel *panel=[[NSPanel alloc] initWithContentRect:NSMakeRect(box.origin.x,h-CGRectGetMaxY(box),box.size.width,box.size.height) styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
    panel.releasedWhenClosed=NO;panel.hidesOnDeactivate=NO;panel.opaque=YES;panel.backgroundColor=NSColor.darkGrayColor;panel.level=NSFloatingWindowLevel;
    panel.ignoresMouseEvents=NO;[panel orderFront:nil];
    void *sky=dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",RTLD_NOW);
    uint32_t(*mainConnection)(void)=dlsym(sky,"SLSMainConnectionID");
    int(*order)(uint32_t,uint32_t,int,uint32_t)=dlsym(sky,"SLSOrderWindow");
    typedef int(*Find)(uint32_t,uint32_t,int,int,CGPoint *,CGPoint *,uint32_t *,uint32_t *);
    Find find=dlsym(sky,"SLSFindWindowAndOwner");require(mainConnection&&order&&find,@"occlusion validation symbols absent");
    uint32_t cid=mainConnection(),top=0,owner=0;CGPoint point=CGPointMake(CGRectGetMidX(box),CGRectGetMidY(box)),local=CGPointZero;
    require(order(cid,(uint32_t)panel.windowNumber,1,target)==0,@"owned occluder order failed");pump(0.15);
    int result=find(cid,0,1,0,&point,&local,&top,&owner);
    int(*bounds)(uint32_t,uint32_t,CGRect *)=dlsym(sky,"SLSGetWindowBounds");
    int(*list)(uint32_t,uint32_t,uint32_t,uint32_t *,uint32_t *)=dlsym(sky,"SLSGetOnScreenWindowList");
    require(bounds&&list,@"occlusion metadata symbols absent");
    CGRect actual=CGRectZero;uint32_t windows[4096],count=0;int be=bounds(cid,(uint32_t)panel.windowNumber,&actual),le=list(cid,0,4096,windows,&count);
    NSInteger pi=-1,ti=-1;for(uint32_t i=0;i<MIN(count,4096);i++){if(windows[i]==(uint32_t)panel.windowNumber)pi=i;if(windows[i]==target)ti=i;}
    emit(@{@"stage":@"occlusion-setup",@"findError":@(result),@"pointerWindow":@(top),@"panelWindow":@(panel.windowNumber),@"targetWindow":@(target),@"boundsError":@(be),@"listError":@(le),@"panelIndex":@(pi),@"targetIndex":@(ti),@"panelBounds":@[@(actual.origin.x),@(actual.origin.y),@(actual.size.width),@(actual.size.height)],@"requestedBounds":@[@(box.origin.x),@(box.origin.y),@(box.size.width),@(box.size.height)],@"ignoresMouseEvents":@(panel.ignoresMouseEvents)});
    require(be==0&&CGRectEqualToRect(actual,box)&&le==0&&pi>=0&&ti>=0&&pi<ti&&result==0&&top==(uint32_t)panel.windowNumber,@"owned occluder is not the top pointer surface");
    emit(@{@"stage":@"observation",@"phase":@"occluded",@"window":@(target),@"AXFullScreen":attribute(window,@"AXFullScreen"),@"buttons":sample(app,window),@"occluderVerifiedAbove":@YES});
    [panel close];pump(0.1);dlclose(sky);
}
static void notify(AXObserverRef observer,AXUIElementRef element,CFStringRef name,void *context){(void)observer;(void)element;(void)context;[notifications addObject:@{@"name":(__bridge NSString *)name,@"uptime":@(NSProcessInfo.processInfo.systemUptime)}];}
static void controller(BOOL full){
    require(AXIsProcessTrusted(),@"AX permission is not available; no request made");
    previous=NSWorkspace.sharedWorkspace.frontmostApplication;
    child=NSTask.new;child.executableURL=[NSURL fileURLWithPath:NSProcessInfo.processInfo.arguments[0]];
    child.arguments=@[@"--child",root];child.standardOutput=NSFileHandle.fileHandleWithStandardOutput;
    require([child launchAndReturnError:nil],@"fixture launch failed");NSDictionary *ready=awaitSerial(@"ready.json",nil);
    require([ready[@"pid"] intValue]==child.processIdentifier,@"child PID differs");
    AXUIElementRef app=AXUIElementCreateApplication(child.processIdentifier);AXUIElementSetMessagingTimeout(app,0.3);
    AXObserverRef observer=NULL;AXError observed=AXObserverCreate(child.processIdentifier,notify,&observer);
    if(observed==0){CFRunLoopAddSource(CFRunLoopGetMain(),AXObserverGetRunLoopSource(observer),kCFRunLoopDefaultMode);
        AXUIElementRef window=exactWindow(app,[ready[@"window"] unsignedIntValue]);
        for(NSString *name in @[@"AXLayoutChanged",@"AXWindowResized",@"AXMoved",@"AXValueChanged",@"AXUIElementDestroyed"]){
            emit(@{@"stage":@"observer-registration",@"name":name,@"result":@(AXObserverAddNotification(observer,window,(__bridge CFStringRef)name,NULL))});
        }
        CFRelease(window);
    }
    NSMutableArray *phases=[@[@"shown",@"disabled",@"hidden",@"only-close",@"alpha-zero",@"reveal-zero",@"reveal-half",@"ancestor-hidden",@"restored"] mutableCopy];
    if(full)[phases addObjectsFromArray:@[@"fullscreen",@"post-fullscreen"]];
    NSUInteger serial=0;
    for(NSString *name in phases){
        save(@"command.json",@{@"serial":@(++serial),@"phase":name});NSDictionary *ack=awaitSerial(@"ack.json",@(serial));
        AXUIElementRef window=exactWindow(app,[ack[@"window"] unsignedIntValue]);
        double start=NSProcessInfo.processInfo.systemUptime;NSArray *buttons=sample(app,window);
        emit(@{@"stage":@"observation",@"phase":name,@"window":ack[@"window"],@"AXFullScreen":attribute(window,@"AXFullScreen"),@"buttons":buttons,@"queryMs":@((NSProcessInfo.processInfo.systemUptime-start)*1000),@"uptime":@(start)});
        if([name isEqual:@"shown"])occlusionCheck(app,window,[ack[@"window"] unsignedIntValue]);
        CFRelease(window);save(@"command.json",@{@"serial":@(++serial),@"phase":@"sampled"});awaitSerial(@"ack.json",@(serial));
    }
    save(@"command.json",@{@"serial":@(++serial),@"phase":@"quit"});awaitSerial(@"ack.json",@(serial));[child waitUntilExit];
    emit(@{@"stage":@"notifications",@"events":notifications});
    if(observer){CFRunLoopRemoveSource(CFRunLoopGetMain(),AXObserverGetRunLoopSource(observer),kCFRunLoopDefaultMode);CFRelease(observer);}CFRelease(app);
    finish(0,@"metadata comparison complete; no pixels captured or universal visibility claim");
}
static void scanRunning(void){
    require(AXIsProcessTrusted(),@"AX not available; no request made");
    NSSet *allowed=[NSSet setWithArray:@[@"com.google.Chrome",@"com.microsoft.edgemac",@"com.apple.TextEdit"]];NSUInteger total=0;
    for(NSRunningApplication *running in NSWorkspace.sharedWorkspace.runningApplications){
        if(![allowed containsObject:running.bundleIdentifier?:@""])continue;
        AXUIElementRef app=AXUIElementCreateApplication(running.processIdentifier);AXUIElementSetMessagingTimeout(app,0.3);CFTypeRef windows=NULL;
        AXError result=axRead(app,@"AXWindows",&windows);
        emit(@{@"stage":@"running-app",@"bundleIdentifier":running.bundleIdentifier,@"pid":@(running.processIdentifier),@"windowsError":@(result)});
        if(result==0&&windows&&CFGetTypeID(windows)==CFArrayGetTypeID()){
            NSUInteger count=0;for(id item in (__bridge NSArray *)windows){
                if(count++>=3)break;AXUIElementRef window=(__bridge AXUIElementRef)item;uint32_t wid=0;
                if(getWindowID(window,&wid)!=kAXErrorSuccess)continue;
                emit(@{@"stage":@"running-window",@"bundleIdentifier":running.bundleIdentifier,@"pid":@(running.processIdentifier),@"window":@(wid),@"AXFullScreen":attribute(window,@"AXFullScreen"),@"buttons":sample(app,window)});total++;
            }
        }
        if(windows)CFRelease(windows);CFRelease(app);
    }
    emit(@{@"stage":@"scan-summary",@"windows":@(total),@"displayRects":displayRects(),@"screenCaptureUsed":@NO});finish(0,@"read-only running-app metadata scan complete");
}
static void browserTest(NSString *engine){
    require(AXIsProcessTrusted(),@"AX unavailable; no request made");
    BOOL chrome=[engine isEqual:@"chrome"];require(chrome||[engine isEqual:@"edge"],@"unsupported browser case");
    NSString *bundle=chrome?@"com.google.Chrome":@"com.microsoft.edgemac";
    NSString *path=chrome?@"/Applications/Google Chrome.app":@"/Applications/Microsoft Edge.app";
    require([NSRunningApplication runningApplicationsWithBundleIdentifier:bundle].count==0,@"target already running; no user browser may be changed");
    NSBundle *installed=[NSBundle bundleWithPath:path];require(installed.executablePath!=nil,@"browser not installed");
    previous=NSWorkspace.sharedWorkspace.frontmostApplication;
    child=NSTask.new;child.executableURL=[NSURL fileURLWithPath:installed.executablePath];
    child.arguments=@[[@"--user-data-dir=" stringByAppendingString:[root stringByAppendingPathComponent:@"profile"]],@"--no-first-run",@"--no-default-browser-check",@"--disable-background-networking",@"--disable-component-update",@"--disable-sync",@"--disable-extensions",@"--new-window",@"about:blank"];
    for(NSString *name in @[@"browser.stdout",@"browser.stderr"]){[NSFileManager.defaultManager createFileAtPath:[root stringByAppendingPathComponent:name] contents:nil attributes:nil];}
    child.standardOutput=[NSFileHandle fileHandleForWritingAtPath:[root stringByAppendingPathComponent:@"browser.stdout"]];
    child.standardError=[NSFileHandle fileHandleForWritingAtPath:[root stringByAppendingPathComponent:@"browser.stderr"]];
    require([child launchAndReturnError:nil],@"owned browser launch failed");
    emit(@{@"stage":@"browser-launched",@"bundleIdentifier":bundle,@"pid":@(child.processIdentifier),@"version":[installed objectForInfoDictionaryKey:@"CFBundleShortVersionString"]?:@"unknown",@"arguments":child.arguments});
    AXUIElementRef app=AXUIElementCreateApplication(child.processIdentifier);AXUIElementSetMessagingTimeout(app,0.3);
    AXUIElementRef window=NULL;NSDate *end=[NSDate dateWithTimeIntervalSinceNow:12];
    while(!window&&child.running&&end.timeIntervalSinceNow>0){
        CFTypeRef windows=NULL;if(axRead(app,@"AXWindows",&windows)==0&&windows&&CFGetTypeID(windows)==CFArrayGetTypeID()&&CFArrayGetCount(windows)==1){
            AXUIElementRef candidate=(AXUIElementRef)CFArrayGetValueAtIndex(windows,0);uint32_t wid=0;
            if(getWindowID(candidate,&wid)==0&&wid)window=(AXUIElementRef)CFRetain(candidate);
        }
        if(windows)CFRelease(windows);pump(0.05);
    }
    require(window!=NULL,@"owned browser did not expose exactly one AX window");
    uint32_t wid=0;require(getWindowID(window,&wid)==0&&wid,@"browser AX window has no ID");
    pid_t owner=0;require(AXUIElementGetPid(window,&owner)==0&&owner==child.processIdentifier,@"browser AX owner mismatch");
    NSRunningApplication *running=[NSRunningApplication runningApplicationWithProcessIdentifier:owner];[running activateWithOptions:0];pump(0.8);
    for(NSString *phase in @[@"windowed",@"fullscreen",@"post-fullscreen"]){
        BOOL full=[phase isEqual:@"fullscreen"];
        if(![phase isEqual:@"windowed"]){
            AXError set=AXUIElementSetAttributeValue(window,CFSTR("AXFullScreen"),full?kCFBooleanTrue:kCFBooleanFalse);
            require(set==0,@"owned browser fullscreen AX write failed");
            BOOL matched=NO;end=[NSDate dateWithTimeIntervalSinceNow:8];
            do{NSDictionary *state=attribute(window,@"AXFullScreen");matched=[state[@"error"] intValue]==0&&[state[@"value"] respondsToSelector:@selector(boolValue)]&&[state[@"value"] boolValue]==full;if(!matched)pump(0.05);}while(!matched&&end.timeIntervalSinceNow>0);
            require(matched,@"owned browser fullscreen AX state timed out");pump(1.2);
        }
        emit(@{@"stage":@"browser-observation",@"bundleIdentifier":bundle,@"phase":phase,@"pid":@(owner),@"window":@(wid),@"AXFullScreen":attribute(window,@"AXFullScreen"),@"buttons":sample(app,window)});
    }
    CFRelease(window);CFRelease(app);require([running terminate],@"owned browser graceful termination rejected");
    end=[NSDate dateWithTimeIntervalSinceNow:8];while(child.running&&end.timeIntervalSinceNow>0)pump(0.05);
    require(!child.running,@"owned browser did not exit gracefully");finish(0,@"owned browser AX metadata complete; no pixel visibility claim");
}
int main(int argc,const char **argv){@autoreleasepool{
    setbuf(stdout,NULL);BOOL run=argc>=3&&!strcmp(argv[1],"--run"),isChild=argc==3&&!strcmp(argv[1],"--child"),scan=argc==2&&!strcmp(argv[1],"--scan-running");
    BOOL browser=argc==4&&!strcmp(argv[1],"--browser");
    if(!run&&!isChild&&!scan&&!browser){emit(@{@"plan":@"AX metadata only: disposable separate-process fixture, native truth and owned occluder; optional fullscreen. --browser chrome|edge IPCROOT launches only an absent browser with a disposable profile, samples windowed/fullscreen/restored, exits it. --scan-running reads Chrome/Edge/TextEdit metadata. No capture, permission request, user-window change or title/page text reads."});return 0;}
    if(!scan){root=@(argv[browser?3:2]);require([root containsString:@"/margin-button-visibility-"]&&[NSFileManager.defaultManager fileExistsAtPath:[root stringByAppendingPathComponent:@".owned-fixture"]],@"not an owned fixture");}
    char build[32]={0};size_t length=sizeof(build);require(!sysctlbyname("kern.osversion",build,&length,NULL,0)&&!strcmp(build,"26B131"),@"requires inspected build 26B131");
    alarm(55);notifications=NSMutableArray.array;
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];[NSApp finishLaunching];
    void *ax=dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",RTLD_NOW);getWindowID=dlsym(ax,"_AXUIElementGetWindow");require(getWindowID!=NULL,@"AX window-ID lookup absent");
    emit(@{@"stage":@"identity",@"pid":@(getpid()),@"parentPID":@(getppid()),@"AXTrusted":@(AXIsProcessTrusted()),@"role":isChild?@"child":@"controller",@"build":@(build),@"screenCaptureUsed":@NO});
    if(scan)scanRunning();
    if(!isChild)emit(@{@"stage":@"display-metadata",@"rects":displayRects()});
    if(browser)browserTest(@(argv[2]));
    if(isChild)fixture();else controller(argc==4&&!strcmp(argv[3],"--fullscreen"));
}return 0;}
