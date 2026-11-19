// Research backend. AX + private WindowServer metadata only. No capture APIs,
// image reads, fixture truth reads, recorder launch or measurement feedback.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <dlfcn.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <unistd.h>

static void *sky;
static uint32_t cid,target,cover;
static BOOL alive=YES,visible=NO,seeded=NO;
static CGRect relative;
static NSLock *lock;
static NSUInteger moveCallbacks,moveFailures;
static double lastMotion;
typedef int (*Bounds)(uint32_t,uint32_t,CGRect *);
typedef int (*Move)(uint32_t,uint32_t,const CGPoint *);
static Bounds getBounds;
static Move moveWindow;
static double now(void){return NSProcessInfo.processInfo.systemUptime;}
static void emit(NSDictionary *r){NSData *d=[NSJSONSerialization dataWithJSONObject:r options:NSJSONWritingSortedKeys error:nil];if(d)puts([[NSString alloc]initWithData:d encoding:NSUTF8StringEncoding].UTF8String);}
static void check(BOOL ok,NSString *reason){if(!ok){emit(@{@"error":reason});exit(2);}}
static NSArray *rectJSON(CGRect r){return @[@(r.origin.x),@(r.origin.y),@(r.size.width),@(r.size.height)];}
static void pump(void){for(int i=0;i<10;i++){NSEvent *e=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast inMode:NSDefaultRunLoopMode dequeue:YES];if(!e)break;[NSApp sendEvent:e];}}
static double cpu(void){struct rusage r;getrusage(RUSAGE_SELF,&r);return r.ru_utime.tv_sec+r.ru_utime.tv_usec/1e6+r.ru_stime.tv_sec+r.ru_stime.tv_usec/1e6;}
static void moved(uint32_t event,void *data,size_t length,void *context){
    (void)context;uint32_t wid=0;if(length==4&&data)memcpy(&wid,data,4);
    if(wid!=target||(event!=806&&event!=807))return;
    [lock lock];
    lastMotion=now();
    if(alive&&seeded&&visible&&cover){CGRect b=CGRectZero;moveCallbacks++;
        if(getBounds(cid,target,&b)==0){CGPoint p=CGPointMake(b.origin.x+relative.origin.x,b.origin.y+relative.origin.y);if(moveWindow(cid,cover,&p)!=0)moveFailures++;}
        else moveFailures++;
    }
    [lock unlock];
}
static AXError readAX(AXUIElementRef e,CFStringRef key,CFTypeRef *out){return AXUIElementCopyAttributeValue(e,key,out);}
static BOOL getRect(AXUIElementRef e,CGRect *r){
    CFTypeRef value=NULL;AXError error=readAX(e,CFSTR("AXFrame"),&value);BOOL ok=NO;
    if(!error&&value&&CFGetTypeID(value)==AXValueGetTypeID()&&AXValueGetType(value)==kAXValueCGRectType)ok=AXValueGetValue(value,kAXValueCGRectType,r);
    if(value)CFRelease(value);
    return ok&&isfinite(r->origin.x)&&isfinite(r->origin.y)&&isfinite(r->size.width)&&isfinite(r->size.height)&&r->size.width>0&&r->size.height>0;
}
int main(int argc,const char **argv){@autoreleasepool{
    setbuf(stdout,NULL);
    BOOL overflow=argc==10&&!strcmp(argv[9],"--overflow-guard");
    if((argc!=9&&!overflow)||strcmp(argv[1],"--watch")){emit(@{@"plan":@"--watch PID WINDOW_ID OWNED_ROOT HZ SECONDS COVER_PADDING ENABLE_COVER [--overflow-guard]; metadata-only AX polling + private 806/807 tracking. Optional guard deliberately extends beyond target bounds. No recording/image/fixture/recorder inputs."});return 0;}
    pid_t pid=atoi(argv[2]);target=(uint32_t)strtoul(argv[3],NULL,10);NSString *root=@(argv[4]);double hz=atof(argv[5]),seconds=atof(argv[6]),padding=atof(argv[7]);BOOL covering=atoi(argv[8])!=0;
    check([root containsString:@"/test-results/button-visibility-recorded-"]&&[NSFileManager.defaultManager fileExistsAtPath:[root stringByAppendingPathComponent:@".owned-fixture"]],@"not an owned lab root");
    check(pid>1&&target&&hz>=5&&hz<=120&&seconds>0&&seconds<=45&&padding>=0&&padding<=32,@"invalid bounded plan");
    char build[32]={0};size_t n=sizeof(build);check(!sysctlbyname("kern.osversion",build,&n,NULL,0)&&!strcmp(build,"26B131"),@"uninspected OS build");
    check(AXIsProcessTrusted(),@"AX not authorized; no request made");alarm(55);
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];[NSApp finishLaunching];lock=NSLock.new;
    sky=dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",RTLD_NOW);
    uint32_t(*mainCID)(void)=dlsym(sky,"SLSMainConnectionID");getBounds=dlsym(sky,"SLSGetWindowBounds");moveWindow=dlsym(sky,"SLSMoveWindow");
    int(*ownerFn)(uint32_t,uint32_t,uint32_t *)=dlsym(sky,"SLSGetWindowOwner");int(*pidFn)(uint32_t,pid_t *)=dlsym(sky,"SLSConnectionGetPID");
    int(*order)(uint32_t,uint32_t,int,uint32_t)=dlsym(sky,"SLSOrderWindow");
    check(mainCID&&getBounds&&moveWindow&&ownerFn&&pidFn&&order,@"private symbols absent");cid=mainCID();
    uint32_t owner=0;pid_t actual=0;check(ownerFn(cid,target,&owner)==0&&pidFn(owner,&actual)==0&&actual==pid&&actual!=getpid(),@"foreign target identity differs");
    AXUIElementRef app=AXUIElementCreateApplication(pid);AXUIElementSetMessagingTimeout(app,0.15);
    CFTypeRef windows=NULL;check(readAX(app,kAXWindowsAttribute,&windows)==0&&windows&&CFGetTypeID(windows)==CFArrayGetTypeID(),@"AX windows absent");
    AXError(*axWindow)(AXUIElementRef,uint32_t *)=dlsym(RTLD_DEFAULT,"_AXUIElementGetWindow");check(axWindow!=NULL,@"AX window identity SPI absent");
    AXUIElementRef window=NULL;
    for(id item in (__bridge NSArray *)windows){uint32_t number=0;if(axWindow((__bridge AXUIElementRef)item,&number)==0&&number==target){window=(AXUIElementRef)CFRetain((__bridge CFTypeRef)item);break;}}
    CFRelease(windows);check(window!=NULL,@"exact AX window absent");AXUIElementSetMessagingTimeout(window,0.15);
    CFStringRef keys[]={CFSTR("AXCloseButton"),CFSTR("AXMinimizeButton"),CFSTR("AXZoomButton")};AXUIElementRef buttons[3]={NULL,NULL,NULL};
    NSPanel *panel=nil;
    if(covering){panel=[[NSPanel alloc]initWithContentRect:NSMakeRect(0,0,62+2*padding,16+2*padding) styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];panel.releasedWhenClosed=NO;panel.hidesOnDeactivate=NO;panel.opaque=YES;panel.backgroundColor=[NSColor colorWithCalibratedRed:0.12 green:0.14 blue:0.18 alpha:1];panel.ignoresMouseEvents=YES;panel.level=NSFloatingWindowLevel;panel.collectionBehavior=NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorFullScreenAuxiliary;cover=(uint32_t)panel.windowNumber;}
    int(*request)(uint32_t,uint32_t *,int)=dlsym(sky,"SLSRequestNotificationsForWindows");int(*reg)(void *,uint32_t,void *)=dlsym(sky,"SLSRegisterNotifyProc");
    check(request&&reg&&request(cid,&target,1)==0&&reg((void *)moved,806,NULL)==0&&reg((void *)moved,807,NULL)==0,@"private notification setup failed");
    CGDirectDisplayID displays[32];uint32_t count=0;check(CGGetActiveDisplayList(32,displays,&count)==0,@"display geometry absent");
    NSString *stop=[root stringByAppendingPathComponent:@"detector.stop"];
    emit(@{@"stage":@"ready",@"pid":@(getpid()),@"targetPID":@(pid),@"targetWindow":@(target),@"coverWindow":@(cover),@"hz":@(hz),@"padding":@(padding),@"overflowGuard":@(overflow),@"covering":@(covering),@"captureBackend":@NO,@"uptime":@(now())});
    double start=now(),cpuStart=cpu(),next=start,reacquire=0;NSUInteger ticks=0,overruns=0;double queryTotal=0,queryMax=0;
    while(now()-start<seconds&&![NSFileManager.defaultManager fileExistsAtPath:stop]){@autoreleasepool{
        double tick=now();CGRect before=CGRectZero,after=CGRectZero;check(getBounds(cid,target,&before)==0,@"target gone");
        if(tick>=reacquire){for(int i=0;i<3;i++){if(buttons[i])CFRelease(buttons[i]);buttons[i]=NULL;CFTypeRef value=NULL;
            if(readAX(window,keys[i],&value)==0&&value&&CFGetTypeID(value)==AXUIElementGetTypeID()){buttons[i]=(AXUIElementRef)value;AXUIElementSetMessagingTimeout(buttons[i],0.1);}else if(value)CFRelease(value);
        }reacquire=tick+0.5;}
        NSMutableArray *states=NSMutableArray.array;CGRect group=CGRectNull;BOOL any=NO,unknown=NO;
        for(int i=0;i<3;i++){
            CGRect r=CGRectZero;NSString *state=@"unknown";AXError hitError=kAXErrorInvalidUIElement;
            if(buttons[i]&&getRect(buttons[i],&r)){
                group=CGRectUnion(group,r);BOOL onDisplay=NO;for(uint32_t j=0;j<count;j++)if(CGRectIntersectsRect(r,CGDisplayBounds(displays[j])))onDisplay=YES;
                if(!onDisplay)state=@"off-display";
                else{AXUIElementRef hit=NULL;hitError=AXUIElementCopyElementAtPosition(app,CGRectGetMidX(r),CGRectGetMidY(r),&hit);
                    if(hitError==0&&hit){state=CFEqual(hit,buttons[i])?@"hit":@"miss";CFRelease(hit);}else state=@"unknown";}
            }
            any|=[state isEqual:@"hit"];unknown|=[state isEqual:@"unknown"];
            [states addObject:@{@"kind":@(i),@"state":state,@"hitError":@(hitError),@"frame":rectJSON(r)}];
        }
        check(getBounds(cid,target,&after)==0,@"target gone after sample");
        BOOL stable=CGRectEqualToRect(before,after),front=NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==pid;
        if(covering){[lock lock];
            // AX's app-side frame can lag WindowServer movement. Preserve the
            // last validated local layout during motion instead of recalibrating
            // a stale global AX frame into a new, incorrect local offset.
            if(stable&&(!seeded||tick-lastMotion>0.12)&&!CGRectIsNull(group)&&group.size.width<180&&group.size.height<80){
                CGRect padded=overflow?CGRectInset(group,-padding,-padding):CGRectIntersection(CGRectInset(group,-padding,-padding),after);
                if(!CGRectIsNull(padded)&&padded.size.width>0&&padded.size.height>0){
                    CGRect nextRelative=CGRectOffset(padded,-after.origin.x,-after.origin.y);
                    if(!seeded||!CGRectEqualToRect(relative,nextRelative)){
                        relative=nextRelative;seeded=YES;
                        double h=CGDisplayBounds(CGMainDisplayID()).size.height;[panel setFrame:NSMakeRect(padded.origin.x,h-CGRectGetMaxY(padded),padded.size.width,padded.size.height) display:YES];
                    }
                }
            }
            BOOL show=seeded&&any&&!unknown&&front;
            if(show){CGRect latest=CGRectZero;check(getBounds(cid,target,&latest)==0,@"target gone before cover move");CGPoint p=CGPointMake(latest.origin.x+relative.origin.x,latest.origin.y+relative.origin.y);check(moveWindow(cid,cover,&p)==0,@"cover move failed");}
            // Keep AppKit's ordering state consistent with private ordering;
            // otherwise a later AppKit commit can order the panel back out.
            if(show!=visible){if(show)[panel orderFront:nil];else[panel orderOut:nil];check(order(cid,cover,show?1:0,show?target:0)==0,@"cover order failed");visible=show;}
            [lock unlock];
        }
        double cost=(now()-tick)*1000;queryTotal+=cost;queryMax=fmax(queryMax,cost);ticks++;
        emit(@{@"stage":@"sample",@"uptime":@(tick),@"finishedUptime":@(now()),@"queryMs":@(cost),@"buttons":states,@"stableBounds":@(stable),@"targetBounds":rectJSON(after),@"front":@(front),@"coverVisible":@(visible)});
        next+=1/hz;if(now()>next){overruns++;next=now();}
        pump();double remaining=next-now();if(remaining>0)[NSThread sleepForTimeInterval:remaining];
    }}
    [lock lock];alive=NO;visible=NO;[lock unlock];
    if(panel)[panel close];for(int i=0;i<3;i++)if(buttons[i])CFRelease(buttons[i]);CFRelease(window);CFRelease(app);
    double elapsed=now()-start,cpuTime=cpu()-cpuStart;
    emit(@{@"complete":@YES,@"pid":@(getpid()),@"ticks":@(ticks),@"elapsedSeconds":@(elapsed),@"processCPUSeconds":@(cpuTime),@"oneCoreCPUPercent":@(cpuTime/elapsed*100),@"meanQueryMs":@(queryTotal/MAX(ticks,1)),@"maxQueryMs":@(queryMax),@"overruns":@(overruns),@"moveCallbacks":@(moveCallbacks),@"moveFailures":@(moveFailures),@"captureBackend":@NO});
}return 0;}
