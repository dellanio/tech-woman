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

    def run(self, argv, ok=(0,), error=None, stdin=None):
        """Run argv; a status outside `ok` raises HostError(83, error or ...). Returns CompletedProcess."""
        launcher = [self.paths['TW_BASH'], '--noprofile', '--norc', '-c', 'export PATH="$1"; shift; exec "$@"', 'tw',
                    self.paths['PATH'], *argv]
        done = subprocess.run(launcher, capture_output=True, input=stdin, encoding='utf-8', errors='replace')
        if done.returncode not in ok:
            raise HostError(83, error or ('%s failed with status %d' % (argv[0], done.returncode)))
        return done
