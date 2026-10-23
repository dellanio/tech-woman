"""Host command runner for the operator CLI: argv lists only, PATH taken from the installed paths.env.

Nothing here builds a shell command line from data: arguments are passed as an argv list to `bash -c 'exec "$@"'`
only so that the PATH from paths.env decides which docker/fuser/systemctl runs (tests put fakes first).
"""
import subprocess


class HostError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Runner:
    def __init__(self, paths):
        self.paths = paths

    def run(self, argv, ok=(0,), error=None, stdin=None, stdin_path=None, stdout_path=None):
        """Run argv; a status outside `ok` raises HostError(83, error or ...). Returns CompletedProcess.

        stdin_path/stdout_path stream binary data (database dumps) from/into a file; stdout_path is created
        exclusively with mode 0600 and never overwrites an existing file."""
        launcher = [self.paths['TW_BASH'], '--noprofile', '--norc', '-c', 'export PATH="$1"; shift; exec "$@"', 'tw',
                    self.paths['PATH'], *argv]
        if stdin_path is None and stdout_path is None:
            done = subprocess.run(launcher, capture_output=True, input=stdin, encoding='utf-8', errors='replace')
        else:
            import os
            source = open(stdin_path, 'rb') if stdin_path is not None else subprocess.DEVNULL
            target = os.fdopen(os.open(stdout_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb')                 if stdout_path is not None else subprocess.PIPE
            try:
                done = subprocess.run(launcher, stdin=source, stdout=target, stderr=subprocess.PIPE)
            finally:
                for handle in (source, target):
                    if hasattr(handle, 'close'):
                        handle.close()
            done.stderr = done.stderr.decode('utf-8', 'replace')
            if isinstance(done.stdout, bytes):
                done.stdout = done.stdout.decode('utf-8', 'replace')
        if done.returncode not in ok:
            raise HostError(83, error or ('%s failed with status %d' % (argv[0], done.returncode)))
        return done
