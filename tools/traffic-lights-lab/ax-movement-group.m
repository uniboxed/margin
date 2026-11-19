// Metadata/authority experiment only: AX trusted, own/foreign movement groups.
#define main archivedMetadataProbeMain
#include "ax-button-visibility.m"
#undef main
static int(*groupWarp)(uint32_t,CGPoint);
static int(*groupPost)(uint32_t,CGPoint,bool,uint32_t,bool,...);
static uint32_t groupCID;
static CGPoint originalCursor,lastDragPoint;
static BOOL dragging;
static void restoreDrag(void){if(dragging&&groupPost)groupPost(groupCID,lastDragPoint,true,1,false);if(groupWarp)groupWarp(groupCID,originalCursor);}
int main(int argc,const char **argv){@autoreleasepool{
    setbuf(stdout,NULL);BOOL drag=argc==4&&!strcmp(argv[3],"--drag");if((argc!=3&&!drag)||strcmp(argv[1],"--run")){emit(@{@"plan":@"--run OWNED_ROOT [--drag]: one disposable child, same-owner group positive then foreign join/readback with AX trusted. Default ordinary owner motion; --drag uses private left-button moves over only the owned titlebar, releases/restores cursor. No capture or controller cover following."});return 0;}
    root=@(argv[2]);require([root containsString:@"/test-results/button-visibility-recorded-"]&&[NSFileManager.defaultManager fileExistsAtPath:[root stringByAppendingPathComponent:@".owned-fixture"]],@"not owned group root");
    char build[32]={0};size_t n=sizeof(build);require(!sysctlbyname("kern.osversion",build,&n,NULL,0)&&!strcmp(build,"26B131"),@"uninspected build");require(AXIsProcessTrusted(),@"AX absent; no request made");alarm(30);
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];[NSApp finishLaunching];previous=NSWorkspace.sharedWorkspace.frontmostApplication;
    void *sky=dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",RTLD_NOW);
    uint32_t(*mainCID)(void)=dlsym(sky,"SLSMainConnectionID");int(*bounds)(uint32_t,uint32_t,CGRect *)=dlsym(sky,"SLSGetWindowBounds");
    int(*join)(uint32_t,uint32_t,uint32_t)=dlsym(sky,"SLSAddWindowToWindowMovementGroup"),(*leave)(uint32_t,uint32_t,uint32_t)=dlsym(sky,"SLSRemoveWindowFromWindowMovementGroup");
    int(*moveGroup)(uint32_t,uint32_t,const CGPoint *)=dlsym(sky,"SLSMoveWindowWithGroup");int(*move)(uint32_t,uint32_t,const CGPoint *)=dlsym(sky,"SLSMoveWindow");
    require(mainCID&&bounds&&join&&leave&&moveGroup&&move,@"group SPI absent");uint32_t cid=mainCID();
    NSPanel *(^panel)(CGFloat)=^NSPanel *(CGFloat x){NSPanel *p=[[NSPanel alloc]initWithContentRect:NSMakeRect(x,600,70,25) styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];p.releasedWhenClosed=NO;p.backgroundColor=NSColor.darkGrayColor;p.level=NSFloatingWindowLevel;[p orderFront:nil];return p;};
    NSPanel *leader=panel(1400),*member=panel(1500);pump(0.1);uint32_t a=(uint32_t)leader.windowNumber,b=(uint32_t)member.windowNumber;
    CGRect la=CGRectZero,ma=CGRectZero,lb=CGRectZero,mb=CGRectZero;require(bounds(cid,a,&la)==0&&bounds(cid,b,&ma)==0,@"owned group bounds absent");int positiveJoin=join(cid,a,b);CGPoint destination=CGPointMake(la.origin.x+40,la.origin.y+20);int moved=moveGroup(cid,a,&destination);pump(0.1);
    require(bounds(cid,a,&lb)==0&&bounds(cid,b,&mb)==0,@"owned moved bounds absent");BOOL follows=fabs(mb.origin.x-ma.origin.x-40)<1&&fabs(mb.origin.y-ma.origin.y-20)<1;
    emit(@{@"stage":@"owned-group-positive",@"AXTrusted":@(AXIsProcessTrusted()),@"joinError":@(positiveJoin),@"moveError":@(moved),@"follows":@(follows)});require(positiveJoin==0&&moved==0&&follows,@"owned group positive control failed");require(leave(cid,a,b)==0,@"owned group detach failed");[leader close];
    child=NSTask.new;child.executableURL=[NSURL fileURLWithPath:@"/tmp/margin-visibility-stimulus"];child.arguments=@[@"--run",root,drag?@"idle":@"group"];
    [NSFileManager.defaultManager createFileAtPath:[root stringByAppendingPathComponent:@"stimulus.jsonl"] contents:nil attributes:nil];child.standardOutput=[NSFileHandle fileHandleForWritingAtPath:[root stringByAppendingPathComponent:@"stimulus.jsonl"]];
    require([child launchAndReturnError:nil],@"group child launch failed");NSDictionary *ready=awaitSerial(@"ready.json",nil);require([ready[@"pid"] intValue]==child.processIdentifier,@"group child PID differs");uint32_t target=[ready[@"window"] unsignedIntValue];
    int(*ownerFn)(uint32_t,uint32_t,uint32_t *)=dlsym(sky,"SLSGetWindowOwner");int(*pidFn)(uint32_t,pid_t *)=dlsym(sky,"SLSConnectionGetPID");uint32_t owner=0;pid_t pid=0;
    require(ownerFn&&pidFn&&ownerFn(cid,target,&owner)==0&&pidFn(owner,&pid)==0&&pid==child.processIdentifier&&owner!=cid,@"foreign group identity differs");
    CGRect targetBefore=CGRectZero,coverBefore=CGRectZero,targetAfter=CGRectZero,coverAfter=CGRectZero;require(bounds(cid,target,&targetBefore)==0,@"foreign target bounds absent");CGPoint start=CGPointMake(targetBefore.origin.x+8,targetBefore.origin.y+8);require(move(cid,b,&start)==0,@"group member seed failed");pump(0.1);require(bounds(cid,b,&coverBefore)==0,@"group member bounds absent");
    int foreign=join(cid,target,b);save(@"stimulus.start",@{@"start":@YES});
    if(drag){
        groupCID=cid;groupWarp=dlsym(sky,"SLSWarpCursorPosition");groupPost=dlsym(sky,"SLSPostMouseEvents");int(*cursor)(uint32_t,CGPoint *)=dlsym(sky,"SLSGetCurrentCursorLocation");
        require(groupWarp&&groupPost&&cursor&&cursor(cid,&originalCursor)==0,@"drag SPI unavailable");atexit(restoreDrag);
        lastDragPoint=CGPointMake(targetBefore.origin.x+200,targetBefore.origin.y+16);require(groupPost(cid,lastDragPoint,true,1,true)==0,@"owned titlebar press failed");dragging=YES;pump(0.08);
        for(int i=1;i<=20;i++){lastDragPoint=CGPointMake(targetBefore.origin.x+200+i*6,targetBefore.origin.y+16+i*2);require(groupPost(cid,lastDragPoint,true,1,true)==0,@"owned drag move failed");pump(0.015);}
        require(groupPost(cid,lastDragPoint,true,1,false)==0,@"owned drag release failed");dragging=NO;pump(0.2);
    }else pump(2.1);
    require(bounds(cid,target,&targetAfter)==0&&bounds(cid,b,&coverAfter)==0,@"foreign group readback absent");
    double dx=targetAfter.origin.x-targetBefore.origin.x,dy=targetAfter.origin.y-targetBefore.origin.y,cx=coverAfter.origin.x-coverBefore.origin.x,cy=coverAfter.origin.y-coverBefore.origin.y;
    emit(@{@"stage":@"foreign-group-with-AX",@"AXTrusted":@(AXIsProcessTrusted()),@"dragStimulus":@(drag),@"joinError":@(foreign),@"targetDelta":@[@(dx),@(dy)],@"memberDelta":@[@(cx),@(cy)],@"followsWithoutControllerMoves":@((fabs(dx)>1||fabs(dy)>1)&&fabs(cx-dx)<1&&fabs(cy-dy)<1),@"childPID":@(pid),@"controllerPID":@(getpid())});
    require(!drag||(fabs(dx)>80&&fabs(dy)>15),@"native titlebar drag stimulus did not move target enough");
    if(foreign==0)leave(cid,target,b);[member close];save(@"stimulus.stop",@{@"stop":@YES});[child waitUntilExit];require(child.terminationStatus==0,@"group child failed");finish(0,@"bounded AX-trusted movement-group authority comparison complete");
}}
