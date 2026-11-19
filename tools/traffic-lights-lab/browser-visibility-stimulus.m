// Disposable installed-browser test driver. Never linked into the detector.
#define main archivedMetadataProbeMain
#include "ax-button-visibility.m"
#undef main
static void(^cleanupToolbar)(void);
static BOOL cleaning;
static void managedRequire(BOOL ok,NSString *reason){if(!ok){if(cleanupToolbar&&!cleaning){cleaning=YES;cleanupToolbar();}finish(2,reason);}}
#define require managedRequire
static void *sky;
static uint32_t cid;
static CGPoint savedCursor;
static BOOL cursorSaved;
static int(*warp)(uint32_t,CGPoint);
static void restoreCursor(void){if(cursorSaved&&warp)warp(cid,savedCursor);}
static AXUIElementRef menuItem(AXUIElementRef app,NSString *menuName,NSArray<NSString *> *titles){
    CFTypeRef bar=NULL,items=NULL;require(axRead(app,@"AXMenuBar",&bar)==0&&bar,@"browser menu bar absent");
    require(axRead((AXUIElementRef)bar,@"AXChildren",&items)==0&&items&&CFGetTypeID(items)==CFArrayGetTypeID(),@"menu bar items absent");
    AXUIElementRef menu=NULL;
    for(id item in (__bridge NSArray *)items){NSDictionary *t=attribute((__bridge AXUIElementRef)item,@"AXTitle");if([t[@"value"] isEqual:menuName]){menu=(AXUIElementRef)CFRetain((__bridge CFTypeRef)item);break;}}
    CFRelease(items);CFRelease(bar);require(menu!=NULL,@"named browser menu absent");
    require(AXUIElementPerformAction(menu,kAXPressAction)==0,@"browser menu open failed");pump(0.15);
    NSMutableArray *queue=[NSMutableArray arrayWithObject:(__bridge id)menu];AXUIElementRef found=NULL;NSUInteger visited=0;
    while(queue.count&&visited++<150&&!found){id item=queue.firstObject;[queue removeObjectAtIndex:0];AXUIElementRef e=(__bridge AXUIElementRef)item;
        NSDictionary *t=attribute(e,@"AXTitle");if([t[@"value"] isKindOfClass:NSString.class]){
            NSString *title=t[@"value"];
            if([title containsString:@"Toolbar"]||[title containsString:@"Private Window"]||[title containsString:@"Full Screen"])emit(@{@"stage":@"menu-capability",@"menu":menuName,@"title":title,@"mark":attribute(e,@"AXMenuItemMarkChar")});
            if([titles containsObject:title]){found=(AXUIElementRef)CFRetain(e);break;}
        }
        CFTypeRef children=NULL;if(axRead(e,@"AXChildren",&children)==0&&children&&CFGetTypeID(children)==CFArrayGetTypeID())[queue addObjectsFromArray:(__bridge NSArray *)children];if(children)CFRelease(children);
    }
    CFRelease(menu);return found;
}
static void full(AXUIElementRef window,BOOL value){
    require(AXUIElementSetAttributeValue(window,CFSTR("AXFullScreen"),value?kCFBooleanTrue:kCFBooleanFalse)==0,@"owned fullscreen write failed");
    double end=NSProcessInfo.processInfo.systemUptime+8;BOOL matched=NO;
    do{NSDictionary *a=attribute(window,@"AXFullScreen");matched=[a[@"error"] intValue]==0&&[a[@"value"] respondsToSelector:@selector(boolValue)]&&[a[@"value"] boolValue]==value;if(!matched)pump(0.03);}while(!matched&&end>NSProcessInfo.processInfo.systemUptime);
    require(matched,@"fullscreen state timeout");pump(1.3);
}
static NSArray *windowNumbers(AXUIElementRef app){
    CFTypeRef windows=NULL;NSMutableArray *numbers=NSMutableArray.array;
    if(axRead(app,@"AXWindows",&windows)==0&&windows&&CFGetTypeID(windows)==CFArrayGetTypeID())for(id item in (__bridge NSArray *)windows){uint32_t wid=0;if(getWindowID((__bridge AXUIElementRef)item,&wid)==0&&wid)[numbers addObject:@(wid)];}
    if(windows)CFRelease(windows);return numbers;
}
int main(int argc,const char **argv){@autoreleasepool{
    setbuf(stdout,NULL);
    if(argc!=4||strcmp(argv[1],"--run")){emit(@{@"plan":@"--run OWNED_ROOT chrome|edge|safari. Refuse existing target, own fresh Chromium profile or Safari private window. AX-only menu/fullscreen, inspected private cursor-move stimulus, own backdrop. No capture. Commands/metadata only; stop first failed setup, restore toolbar/cursor, quit owned app."});return 0;}
    root=@(argv[2]);NSString *engine=@(argv[3]);BOOL safari=[engine isEqual:@"safari"],chrome=[engine isEqual:@"chrome"];
    char build[32]={0};size_t buildLength=sizeof(build);require(!sysctlbyname("kern.osversion",build,&buildLength,NULL,0)&&!strcmp(build,"26B131"),@"requires inspected build 26B131");
    require(safari||chrome||[engine isEqual:@"edge"],@"bad browser case");require([root containsString:@"/test-results/button-visibility-recorded-"]&&[NSFileManager.defaultManager fileExistsAtPath:[root stringByAppendingPathComponent:@".owned-fixture"]],@"not owned lab root");
    alarm(100);require(AXIsProcessTrusted(),@"AX absent; no request made");[NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];[NSApp finishLaunching];
    previous=NSWorkspace.sharedWorkspace.frontmostApplication;
    NSString *bundle=safari?@"com.apple.Safari":chrome?@"com.google.Chrome":@"com.microsoft.edgemac";
    NSString *path=safari?@"/Applications/Safari.app":chrome?@"/Applications/Google Chrome.app":@"/Applications/Microsoft Edge.app";
    require([NSRunningApplication runningApplicationsWithBundleIdentifier:bundle].count==0,@"target already running; no user browser changed");
    NSBundle *installed=[NSBundle bundleWithPath:path];require(installed.executablePath!=nil,@"browser absent");
    sky=dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",RTLD_NOW);uint32_t(*mainCID)(void)=dlsym(sky,"SLSMainConnectionID");
    warp=dlsym(sky,"SLSWarpCursorPosition");int(*cursor)(uint32_t,CGPoint *)=dlsym(sky,"SLSGetCurrentCursorLocation");
    require(mainCID&&warp&&cursor,@"inspected cursor SPI absent");cid=mainCID();require(cursor(cid,&savedCursor)==0,@"cursor read failed");cursorSaved=YES;atexit(restoreCursor);
    getWindowID=dlsym(RTLD_DEFAULT,"_AXUIElementGetWindow");require(getWindowID!=NULL,@"AX window SPI absent");
    child=NSTask.new;child.executableURL=[NSURL fileURLWithPath:installed.executablePath];
    child.arguments=safari?@[@"-ApplePersistenceIgnoreState",@"YES"]:@[[@"--user-data-dir=" stringByAppendingString:[root stringByAppendingPathComponent:@"profile"]],@"--no-first-run",@"--no-default-browser-check",@"--disable-background-networking",@"--disable-component-update",@"--disable-sync",@"--disable-extensions",@"--new-window",@"about:blank"];
    for(NSString *name in @[@"browser.stdout",@"browser.stderr"])[NSFileManager.defaultManager createFileAtPath:[root stringByAppendingPathComponent:name] contents:nil attributes:nil];
    child.standardOutput=[NSFileHandle fileHandleForWritingAtPath:[root stringByAppendingPathComponent:@"browser.stdout"]];child.standardError=[NSFileHandle fileHandleForWritingAtPath:[root stringByAppendingPathComponent:@"browser.stderr"]];
    require([child launchAndReturnError:nil],@"owned browser launch failed");pid_t pid=child.processIdentifier;
    emit(@{@"stage":@"browser-launched",@"engine":engine,@"pid":@(pid),@"version":[installed objectForInfoDictionaryKey:@"CFBundleShortVersionString"]?:@"unknown",@"arguments":child.arguments});
    AXUIElementRef app=AXUIElementCreateApplication(pid);AXUIElementSetMessagingTimeout(app,0.3);double end=NSProcessInfo.processInfo.systemUptime+12;
    BOOL menuReady=NO;
    do{CFTypeRef bar=NULL;menuReady=axRead(app,@"AXMenuBar",&bar)==0&&bar;if(bar)CFRelease(bar);if(!menuReady)pump(0.03);}while(!menuReady&&end>NSProcessInfo.processInfo.systemUptime);
    require(menuReady,@"owned browser AX menu bar absent");
    if(!safari){while(windowNumbers(app).count==0&&end>NSProcessInfo.processInfo.systemUptime)pump(0.03);require(windowNumbers(app).count>0,@"owned browser initial AX window absent");}
    require(AXUIElementSetAttributeValue(app,CFSTR("AXFrontmost"),kCFBooleanTrue)==0,@"AX foreground request failed");pump(0.4);
    NSArray *initial=windowNumbers(app);uint32_t wid=0;
    if(safari){AXUIElementRef item=menuItem(app,@"File",@[@"New Private Window"]);require(item!=NULL,@"Safari private-window action absent");require(AXUIElementPerformAction(item,kAXPressAction)==0,@"Safari private-window action failed");CFRelease(item);end=NSProcessInfo.processInfo.systemUptime+8;
        do{for(NSNumber *number in windowNumbers(app))if(![initial containsObject:number]){wid=number.unsignedIntValue;break;}if(!wid)pump(0.03);}while(!wid&&end>NSProcessInfo.processInfo.systemUptime);
        require(wid!=0,@"new Safari private window absent");
    }else{require(initial.count==1,@"unexpected fresh browser windows");wid=[initial[0] unsignedIntValue];}
    AXUIElementRef window=exactWindow(app,wid);AXUIElementSetMessagingTimeout(window,0.3);
    pump(0.5);NSDictionary *initialFull=attribute(window,@"AXFullScreen");
    emit(@{@"stage":@"initial-owned-window",@"AXFullScreen":initialFull,@"AXPosition":attribute(window,@"AXPosition"),@"AXSize":attribute(window,@"AXSize"),@"AXRole":attribute(window,@"AXRole"),@"AXSubrole":attribute(window,@"AXSubrole")});
    if([initialFull[@"value"] respondsToSelector:@selector(boolValue)]&&[initialFull[@"value"] boolValue])full(window,NO);
    CGPoint p=CGPointMake(100,180);CGSize size=CGSizeMake(920,560);AXValueRef pos=AXValueCreate(kAXValueCGPointType,&p),sz=AXValueCreate(kAXValueCGSizeType,&size);
    AXError positionResult=AXUIElementSetAttributeValue(window,kAXPositionAttribute,pos),sizeResult=AXUIElementSetAttributeValue(window,kAXSizeAttribute,sz);
    emit(@{@"stage":@"owned-window-geometry-write",@"positionError":@(positionResult),@"sizeError":@(sizeResult)});
    require(positionResult==0&&sizeResult==0,@"owned browser geometry setup failed");CFRelease(pos);CFRelease(sz);
    NSWindow *backdrop=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,620,1100,820) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];backdrop.releasedWhenClosed=NO;backdrop.opaque=YES;backdrop.backgroundColor=[NSColor colorWithCalibratedRed:0.16 green:0.18 blue:0.22 alpha:1];backdrop.ignoresMouseEvents=YES;[backdrop orderFront:nil];
    int(*order)(uint32_t,uint32_t,int,uint32_t)=dlsym(sky,"SLSOrderWindow");int(*move)(uint32_t,uint32_t,const CGPoint *)=dlsym(sky,"SLSMoveWindow");CGPoint zero=CGPointZero;
    require(order&&move&&order(cid,(uint32_t)backdrop.windowNumber,-1,wid)==0&&move(cid,(uint32_t)backdrop.windowNumber,&zero)==0,@"browser backdrop setup failed");
    require(AXUIElementPerformAction(window,kAXRaiseAction)==0,@"browser raise failed");pump(0.4);
    require(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==pid,@"owned browser not frontmost");
    save(@"ready.json",@{@"pid":@(pid),@"window":@(wid),@"driverPID":@(getpid())});
    NSNumber *serial=@0;__block BOOL toolbarChanged=NO;
    cleanupToolbar=^{if(toolbarChanged){AXUIElementRef item=menuItem(app,@"View",@[@"Always Show Toolbar in Full Screen",@"Always Show Toolbar in Fullscreen"]);require(item!=NULL&&AXUIElementPerformAction(item,kAXPressAction)==0,@"emergency toolbar restore failed");CFRelease(item);toolbarChanged=NO;pump(0.3);}};
    for(;;){pump(0.01);NSDictionary *request=load(@"browser-command.json");if(!request||[request[@"serial"] isEqual:serial])continue;serial=request[@"serial"];NSString *name=request[@"command"];
        if([name isEqual:@"quit"])break;
        if([name isEqual:@"hide-attributes"]||[name isEqual:@"restore-attributes"]){
            BOOL hiding=[name isEqual:@"hide-attributes"];NSMutableArray *writes=NSMutableArray.array;
            for(NSString *key in @[@"AXCloseButton",@"AXMinimizeButton",@"AXZoomButton"]){CFTypeRef button=NULL;AXError got=axRead(window,key,&button);
                if(got==0&&button&&CFGetTypeID(button)==AXUIElementGetTypeID()){
                    for(NSString *attributeName in @[@"AXHidden",@"AXVisible"]){Boolean writable=false;AXError query=AXUIElementIsAttributeSettable((AXUIElementRef)button,(__bridge CFStringRef)attributeName,&writable);
                        BOOL value=[attributeName isEqual:@"AXHidden"]?hiding:!hiding;AXError wrote=AXUIElementSetAttributeValue((AXUIElementRef)button,(__bridge CFStringRef)attributeName,value?kCFBooleanTrue:kCFBooleanFalse);
                        [writes addObject:@{@"relationship":key,@"attribute":attributeName,@"settableError":@(query),@"settable":@(writable),@"writeError":@(wrote)}];
                    }
                }if(button)CFRelease(button);
            }emit(@{@"stage":@"native-hide-attribute-attempt",@"phase":name,@"writes":writes});pump(0.5);
        }
        else if([name isEqual:@"fullscreen-on"])full(window,YES);
        else if([name isEqual:@"fullscreen-off"])full(window,NO);
        else if([name isEqual:@"toolbar-toggle"]){
            AXUIElementRef item=menuItem(app,@"View",@[@"Always Show Toolbar in Full Screen",@"Always Show Toolbar in Fullscreen"]);require(item!=NULL,@"fullscreen toolbar toggle absent");
            require(AXUIElementPerformAction(item,kAXPressAction)==0,@"toolbar toggle failed");CFRelease(item);toolbarChanged=!toolbarChanged;pump(0.7);
        }else if([name isEqual:@"hover"]||[name isEqual:@"away"]){
            typedef int(*PostMove)(uint32_t,CGPoint,bool,uint32_t,bool,...);PostMove post=dlsym(sky,"SLSPostMouseEvents");require(post!=NULL,@"inspected mouse move SPI absent");
            CGPoint destination=[name isEqual:@"hover"]?CGPointMake(24,2):CGPointMake(700,600);
            require(post(cid,destination,true,1,false)==0,@"mouse move failed");pump(1.0);
        }else require([name isEqual:@"sample"],@"unknown browser command");
        emit(@{@"stage":@"browser-sample",@"phase":name,@"serial":serial,@"uptime":@(NSProcessInfo.processInfo.systemUptime),@"AXFullScreen":attribute(window,@"AXFullScreen"),@"buttons":sample(app,window)});
        save(@"browser-ack.json",@{@"serial":serial,@"ok":@YES});
    }
    cleanupToolbar();cleanupToolbar=nil;
    NSDictionary *state=attribute(window,@"AXFullScreen");if([state[@"value"] respondsToSelector:@selector(boolValue)]&&[state[@"value"] boolValue])full(window,NO);
    [backdrop close];CFRelease(window);CFRelease(app);
    NSRunningApplication *running=[NSRunningApplication runningApplicationWithProcessIdentifier:pid];require([running terminate],@"owned browser quit rejected");end=NSProcessInfo.processInfo.systemUptime+8;while(child.running&&end>NSProcessInfo.processInfo.systemUptime)pump(0.03);require(!child.running,@"owned browser quit timeout");
    save(@"browser-ack.json",@{@"serial":serial,@"ok":@YES});finish(0,@"owned browser test complete; toolbar/cursor restored");
}}
