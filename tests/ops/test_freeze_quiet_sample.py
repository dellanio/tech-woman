"""INT-005: a janela de silêncio do freeze compara DADOS (arquivo, WAL, data_version), não o mtime do índice -shm.

O -shm é memória compartilhada mapeada (mmap): leitores (inclusive a própria conexão somente leitura do freeze) marcam
read-marks nele e o kernel pode atualizar o mtime depois, por writeback. Comparar esse mtime gerava "database changed"
falso (exit 80) sem nenhuma escrita. Uma escrita real continua detectada pelo WAL/data_version/digest.
"""
import os, pathlib, sqlite3, sys, tempfile, unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'ops'))
import freeze  # noqa: E402


class QuietSampleTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(prefix='tw-quiet-')
        self.addCleanup(self.dir.cleanup)
        self.db = pathlib.Path(self.dir.name) / 'tech-woman.db'
        self.writer = sqlite3.connect(self.db)
        self.addCleanup(self.writer.close)
        self.writer.execute('pragma journal_mode=wal')
        self.writer.execute('create table t(i)')
        self.writer.execute('insert into t values (1)')
        self.writer.commit()
        self.reader = sqlite3.connect(self.db.resolve().as_uri() + '?mode=ro', uri=True)
        self.addCleanup(self.reader.close)

    def test_shm_mtime_alone_is_not_a_change(self):
        first = freeze._sample(self.db, self.reader)
        shm = pathlib.Path(str(self.db) + '-shm')
        self.assertTrue(shm.exists())
        info = shm.stat()
        os.utime(shm, ns=(info.st_atime_ns, info.st_mtime_ns + 5_000_000_000))
        self.assertEqual(first, freeze._sample(self.db, self.reader))

    def test_a_real_write_is_still_a_change(self):
        first = freeze._sample(self.db, self.reader)
        self.writer.execute('insert into t values (2)')
        self.writer.commit()
        self.assertNotEqual(first, freeze._sample(self.db, self.reader))


if __name__ == '__main__':
    unittest.main()
