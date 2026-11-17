// A separate sandboxed app. No Accessibility, Apple Events, Safari launch,
// WebBookmarks load, database SQL or profile mutation. User operates Powerbox.
#import <AppKit/AppKit.h>
#include <fcntl.h>
#include <pwd.h>
#include <sys/stat.h>
#include <unistd.h>

static void emit(NSDictionary *row) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:row options:NSJSONWritingSortedKeys error:nil];
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
}
static void finish(NSString *outcome, int status) {
    emit(@{@"complete": @YES, @"outcome": outcome, @"status": @(status), @"realSafariProfileCreated": @NO});
    exit(status);
}
static NSDictionary *probe(NSString *path, int flags) {
    errno = 0;
    int fd = open(path.fileSystemRepresentation, flags | O_CLOEXEC | O_NOFOLLOW);
    int error = fd < 0 ? errno : 0;
    if (fd >= 0) close(fd); // Do not read or write any database bytes.
    return @{@"opened": @(fd >= 0), @"errno": @(error)};
}
static BOOL denied(NSDictionary *result) {
    int error = [result[@"errno"] intValue];
    return ![result[@"opened"] boolValue] && (error == EPERM || error == EACCES);
}

@interface FolderProbe : NSObject <NSApplicationDelegate>
@property NSString *target;
@property NSString *outside;
@property NSString *sibling;
@property NSString *mode;
@property NSURL *bookmarkFile;
@property NSOpenPanel *panel;
@end
@implementation FolderProbe
- (NSDictionary *)access {
    NSString *database = [self.target stringByAppendingPathComponent:@"SafariTabs.db"];
    return @{@"directory": probe(self.target, O_RDONLY | O_DIRECTORY),
             @"databaseReadOpen": probe(database, O_RDONLY),
             @"databaseReadWriteOpen": probe(database, O_RDWR),
             @"outsideControl": probe(self.outside, O_RDONLY),
             @"siblingDirectory": probe(self.sibling, O_RDONLY | O_DIRECTORY)};
}
- (void)checkScope:(NSURL *)url phase:(NSString *)phase {
    NSDictionary *access = [self access];
    emit(@{@"stage": phase, @"access": access});
    if (!denied(access[@"outsideControl"])) finish(@"outside-control-not-denied", 2);
    if (![access[@"directory"][@"opened"] boolValue] ||
        ![access[@"databaseReadOpen"][@"opened"] boolValue] ||
        ![access[@"databaseReadWriteOpen"][@"opened"] boolValue])
        finish(@"selected-directory-insufficient-for-database-open", 2);
    // A successful O_RDWR open is not proof that a write would be accepted.
    // Perform one bounded write to an exclusively-created, owned sentinel only.
    NSString *name = [@".margin-profile-folder-probe-" stringByAppendingString:NSUUID.UUID.UUIDString];
    NSString *path = [url.path stringByAppendingPathComponent:name];
    int fd = open(path.fileSystemRepresentation, O_CREAT | O_EXCL | O_NOFOLLOW | O_RDWR | O_CLOEXEC, 0600);
    int error = fd < 0 ? errno : 0;
    emit(@{@"stage": @"sentinel-create", @"phase": phase, @"created": @(fd >= 0), @"errno": @(error), @"name": name});
    if (fd < 0) finish(@"selected-directory-not-writable", 2);
    const char expected[] = "owned Margin folder-access probe\n";
    char actual[sizeof(expected)] = {0};
    struct stat created = {0}, current = {0};
    BOOL identityKnown = fstat(fd, &created) == 0 && S_ISREG(created.st_mode);
    BOOL wrote = write(fd, expected, sizeof(expected)) == sizeof(expected);
    BOOL synced = wrote && fsync(fd) == 0;
    BOOL readback = pread(fd, actual, sizeof(actual), 0) == sizeof(actual) && !memcmp(actual, expected, sizeof(actual));
    close(fd);
    BOOL same = identityKnown && lstat(path.fileSystemRepresentation, &current) == 0 &&
        current.st_dev == created.st_dev && current.st_ino == created.st_ino;
    BOOL removed = same && unlink(path.fileSystemRepresentation) == 0;
    emit(@{@"stage": @"sentinel-result", @"phase": phase, @"wrote": @(wrote), @"synced": @(synced), @"readback": @(readback), @"removedOwnedInode": @(removed)});
    if (!(wrote && synced && readback && removed)) finish(@"sentinel-failed-see-cleanup-log", 2);
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    struct passwd *user = getpwuid(getuid());
    if (!user) finish(@"real-home-unavailable", 2);
    NSString *realHome = @(user->pw_dir);
    self.target = [realHome stringByAppendingPathComponent:@"Library/Containers/com.apple.Safari/Data/Library/Safari"];
    self.sibling = [realHome stringByAppendingPathComponent:@"Library/Containers/com.apple.Safari/Data/Library/Preferences"];
    self.outside = [NSBundle.mainBundle objectForInfoDictionaryKey:@"OutsideControlPath"];
    NSString *bundleID = NSBundle.mainBundle.bundleIdentifier;
    emit(@{@"stage": @"identity", @"bundleIdentifier": bundleID, @"pid": @(getpid()), @"parentPID": @(getppid()),
           @"sandboxHome": NSHomeDirectory(), @"target": self.target, @"mode": self.mode,
           @"testModel": @"separate ad-hoc-signed App Sandbox app; no fresh-user TCC claim"});
    // Require a separate App Sandbox container, and an ungranted outside file.
    if (![NSHomeDirectory() containsString:[@"/Library/Containers/" stringByAppendingString:bundleID]])
        finish(@"app-sandbox-container-not-active", 2);
    if (![probe(NSBundle.mainBundle.executablePath, O_RDONLY)[@"opened"] boolValue])
        finish(@"owned-positive-control-failed", 2);
    NSDictionary *before = [self access];
    emit(@{@"stage": @"before-grant", @"access": before});
    if (!denied(before[@"outsideControl"]) || !denied(before[@"databaseReadWriteOpen"]) ||
        !denied(before[@"databaseReadOpen"])) finish(@"baseline-not-denied-stop-before-picker", 2);
    NSError *error = nil;
    NSURL *support = [NSFileManager.defaultManager URLForDirectory:NSApplicationSupportDirectory
        inDomain:NSUserDomainMask appropriateForURL:nil create:YES error:&error];
    if (!support) finish(@"owned-bookmark-directory-unavailable", 2);
    self.bookmarkFile = [support URLByAppendingPathComponent:@"margin-folder-probe.bookmark"];
    if ([self.mode isEqual:@"--resume"]) {
        NSData *data = [NSData dataWithContentsOfURL:self.bookmarkFile options:0 error:&error];
        BOOL stale = NO;
        NSURL *url = data ? [NSURL URLByResolvingBookmarkData:data
            options:NSURLBookmarkResolutionWithSecurityScope | NSURLBookmarkResolutionWithoutUI | NSURLBookmarkResolutionWithoutMounting
            relativeToURL:nil bookmarkDataIsStale:&stale error:&error] : nil;
        BOOL started = url && [url startAccessingSecurityScopedResource];
        emit(@{@"stage": @"bookmark-resolve", @"resolved": @(url != nil), @"stale": @(stale), @"started": @(started),
               @"errorDomain": error.domain ?: @"", @"errorCode": @(error.code)});
        if (!started || stale || ![url.path.stringByStandardizingPath isEqual:self.target]) finish(@"bookmark-resume-failed", 2);
        [self checkScope:url phase:@"after-resolve"];
        [url stopAccessingSecurityScopedResource];
        finish(@"persistent-folder-access-verified-no-profile-created", 0);
    }
    if ([NSFileManager.defaultManager fileExistsAtPath:self.bookmarkFile.path])
        finish(@"bookmark-already-exists-use-new-test-identity", 2);
    self.panel = NSOpenPanel.openPanel;
    self.panel.title = @"Margin Safari Folder Access Test";
    self.panel.message = @"Select only Safari's data folder, then Grant Folder Access. The test opens SafariTabs.db without reading or changing it, and creates/deletes one uniquely named test file.";
    self.panel.prompt = @"Grant Folder Access";
    self.panel.canChooseFiles = NO;
    self.panel.canChooseDirectories = YES;
    self.panel.canCreateDirectories = NO;
    self.panel.allowsMultipleSelection = NO;
    self.panel.showsHiddenFiles = YES;
    self.panel.directoryURL = [NSURL fileURLWithPath:self.target isDirectory:YES];
    NSTextField *instructions = [NSTextField wrappingLabelWithString:[@"Expected folder (Shift-Command-G if needed):\n" stringByAppendingString:self.target]];
    instructions.selectable = YES;
    instructions.frame = NSMakeRect(0, 0, 540, 55);
    self.panel.accessoryView = instructions;
    emit(@{@"stage": @"picker-waiting", @"expectedFolder": self.target, @"timeoutSeconds": @600});
    [NSApp activate];
    [self.panel beginWithCompletionHandler:^(NSModalResponse response) {
        if (response != NSModalResponseOK) finish(@"user-cancelled", 3);
        NSURL *url = self.panel.URL;
        if (![url.path.stringByStandardizingPath isEqual:self.target]) finish(@"wrong-directory-selected-no-tests-performed", 2);
        BOOL started = [url startAccessingSecurityScopedResource];
        emit(@{@"stage": @"picker-selected", @"exactTarget": @YES, @"started": @(started)});
        [self checkScope:url phase:@"after-picker"];
        NSError *bookmarkError = nil;
        NSData *bookmark = [url bookmarkDataWithOptions:NSURLBookmarkCreationWithSecurityScope
            includingResourceValuesForKeys:nil relativeToURL:nil error:&bookmarkError];
        BOOL saved = bookmark && [bookmark writeToURL:self.bookmarkFile options:NSDataWritingAtomic error:&bookmarkError];
        emit(@{@"stage": @"bookmark-save", @"saved": @(saved), @"errorDomain": bookmarkError.domain ?: @"", @"errorCode": @(bookmarkError.code)});
        if (started) [url stopAccessingSecurityScopedResource];
        if (!saved) finish(@"bookmark-save-failed", 2);
        finish(@"folder-grant-verified-ready-for-relaunch", 0);
    }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 600 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        emit(@{@"stage": @"picker-timeout"});
        [self.panel cancel:nil];
        finish(@"picker-timed-out", 4);
    });
}
@end

int main(int argc, const char **argv) {
    @autoreleasepool {
        setbuf(stdout, NULL);
        if (argc != 2 || (strcmp(argv[1], "--grant") && strcmp(argv[1], "--resume"))) {
            emit(@{@"plan": @"Launch this signed sandboxed app via LaunchServices with --grant for one user-operated folder picker; --resume checks a saved bookmark without UI. Baseline controls must fail before grant; test database open modes only and an exclusive owned sentinel. No database read/write, profile creation, AX, Apple Events, FDA request or Safari launch."});
            return 0;
        }
        NSApplication *app = NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        FolderProbe *delegate = FolderProbe.new;
        delegate.mode = @(argv[1]);
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
