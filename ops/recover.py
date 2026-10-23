"""Post-write PostgreSQL recovery helpers for the operator CLI (cutover.py record-first-write / recover). Stdlib only.

Every PostgreSQL tool runs INSIDE the PostgreSQL container through `docker exec -i <TW_PG_CONTAINER>` as
TW_PG_ADMIN_USER; SQL travels on stdin and is fixed text built here (identifiers come from the catalogue and are
quoted), never from a request. Reads use READ ONLY transactions. Public reports carry only table names, counts and
pass/fail: no row content, e-mail, token or hash of personal data.
"""
import collections, hashlib, json, pathlib, re

import hostops

ADMIN_DB = 'postgres'
LIVE_TABLES = ['app_user', 'participant', 'enrollment', 'match', 'email_job', 'audit_event']
NAME = re.compile(r'\A[a-z_][a-z0-9_]{0,62}\Z')


class Unreadable(Exception):
    """The live database could not be read: recovery cannot be proven, an operator decision is required."""


class Pg:
    def __init__(self, paths, runner=None, db=None):
        self.runner = runner or hostops.Runner(paths)
        self.prefix = ['docker', 'exec', '-i', paths['TW_PG_CONTAINER']]
        self.user = paths['TW_PG_ADMIN_USER']
        self.db = db or paths['TW_PG_DB']

    def query(self, sql, db=None, error='psql failed'):
        argv = self.prefix + ['psql', '-X', '-q', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-U', self.user,
                              '-d', db or self.db, '-f', '-']
        return self.runner.run(argv, stdin=sql, error=error).stdout

    def read_only(self, sql, db=None, error='read-only query failed'):
        return self.query('begin transaction read only;\n%s;\ncommit;\n' % sql.strip().rstrip(';'), db, error)

    def dump(self, out_path, db=None, schema_only=False):
        self.runner.run(self.prefix + ['pg_dump', '-Fc'] + (['--schema-only'] if schema_only else []) +
                        ['-U', self.user, '-d', db or self.db], stdout_path=out_path, error='pg_dump failed')

    def schema(self, db):
        text = self.runner.run(self.prefix + ['pg_dump', '--schema-only', '-U', self.user, '-d', db],
                               error='pg_dump --schema-only failed').stdout
        # Only comments and the per-run \restrict key of pg_dump >= 16.10 are dropped. Expressions are compared
        # exactly as PostgreSQL deparses them (parentheses included): a AND (b OR c) never equals (a AND b) OR c.
        kept = [line for line in text.splitlines()
                if line.strip() and not line.startswith('--') and not line.startswith(('\\restrict', '\\unrestrict'))]
        return hashlib.sha256('\n'.join(kept).encode('utf-8')).hexdigest()

    def drop_scratch_database(self, name):
        """Only the canonicalisation scratch databases this tool created itself may be dropped."""
        if not (NAME.match(name) and '_canon_' in name):
            raise ValueError('refusing to drop a database that is not a canonicalisation scratch')
        self.query('drop database if exists %s with (force)' % name, ADMIN_DB, error='cannot drop the scratch database')

    def create_database(self, name):
        if not NAME.match(name):
            raise ValueError('unsafe database name')
        self.query('create database %s template template0' % name, ADMIN_DB, error='cannot create the isolated database')

    def restore(self, dump_path, db):
        self.runner.run(self.prefix + ['pg_restore', '--exit-on-error', '--single-transaction', '-U', self.user,
                                       '-d', db], stdin_path=dump_path, error='pg_restore failed')


def canonical_schema(pg, db, workdir, stamp):
    """Schema fingerprint of `db` after ONE PostgreSQL dump/restore round trip (schema only, scratch database).

    pg_restore re-parses CHECK expressions (e.g. it flattens nested ANDs), so a live database and its restored copy
    are compared after the same round trip: PostgreSQL's own parser canonicalises both sides, nothing is erased
    textually, and a regrouped AND/OR stays a difference. The scratch database and dump are removed afterwards."""
    scratch = '%s_canon_%s' % (db, stamp)
    path = pathlib.Path(workdir) / ('.canon-%s.dump' % scratch)
    try:
        pg.dump(path, db, schema_only=True)
        pg.create_database(scratch)
        try:
            pg.restore(path, scratch)
            return pg.schema(scratch)
        finally:
            pg.drop_scratch_database(scratch)
    finally:
        if path.exists():
            path.unlink()


def _json(text):
    lines = [line for line in text.splitlines() if line.strip()]
    return json.loads(lines[-1])


SEQUENCES_BEHIND = """
select count(*) from (
  select s.last_value,
         (xpath('/row/m/text()', query_to_xml(format('select coalesce(max(%I),0) as m from %I.%I', a.attname,
                n.nspname, c.relname), false, true, '')))[1]::text::bigint as max_id
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  join pg_sequences s on (quote_ident(s.schemaname) || '.' || quote_ident(s.sequencename))
       = pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname)
  where c.relkind = 'r' and n.nspname = 'public') x
where coalesce(x.last_value, 0) < x.max_id
"""


def live_facts(pg, baseline):
    """Read-only facts of the live database after a failure: counts, writes after the baseline, sequences."""
    audit_max = baseline.get('audit_max_id', 0)
    if type(audit_max) is not int or audit_max < 0:
        raise ValueError('baseline audit_max_id is not a non-negative integer')
    counts = ','.join("'%s',(select count(*) from public.%s)" % (t, t) for t in LIVE_TABLES)
    sql = ("select json_build_object('tables', json_build_object(%s), 'audit_after_baseline', "
           "(select count(*) from public.audit_event where id > %d), 'sequences_behind', (%s))"
           % (counts, audit_max, SEQUENCES_BEHIND.strip()))
    try:
        facts = _json(pg.read_only(sql, error='the live database is not readable'))
    except (hostops.HostError, ValueError) as error:
        raise Unreadable(str(error))
    facts['first_write_present'] = facts['audit_after_baseline'] >= 1
    return facts


def first_write(pg, baseline):
    """First audited change above the baseline: kind (audit action) and UTC time, nothing personal."""
    audit_max = baseline.get('audit_max_id', 0)
    if type(audit_max) is not int or audit_max < 0:
        raise ValueError('baseline audit_max_id is not a non-negative integer')
    sql = ("select coalesce((select json_build_object('kind', action, 'at', "
           "to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')) from public.audit_event "
           "where id > %d order by id limit 1), 'null'::json)" % audit_max)
    try:
        return _json(pg.read_only(sql, error='the live database is not readable'))
    except (hostops.HostError, ValueError) as error:
        raise Unreadable(str(error))


TABLES = """
select n.nspname || '.' || c.relname,
       quote_ident(n.nspname) || '.' || quote_ident(c.relname),
       coalesce((select string_agg('t.' || quote_ident(a.attname), ',' order by k.ord)
                 from pg_index i cross join unnest(i.indkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                 where i.indrelid = c.oid and i.indisprimary), '')
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
order by 1
"""
TABLE_NAME = re.compile(r'\A[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\Z')
QUALIFIED = re.compile(r'\A[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\Z')
KEY_LIST = re.compile(r'\A(t\.[a-z_][a-z0-9_]*)(,t\.[a-z_][a-z0-9_]*)*\Z')


def _tables(pg, db):
    rows = []
    for line in pg.read_only(TABLES, db).splitlines():
        if not line:
            continue
        name, qualified, keys = line.split('|')
        if not (TABLE_NAME.match(name) and QUALIFIED.match(qualified) and (keys == '' or KEY_LIST.match(keys))):
            raise ValueError('unexpected identifier in the catalogue: %s' % name)
        rows.append((name, qualified, keys))
    return rows


def fingerprint(pg, db):
    """Full logical content of a database: every row of every table keyed by its primary key, every sequence,
    and the schema (DDL, functions, triggers, grants) without dump comments. Kept in memory, never printed."""
    tables = _tables(pg, db)
    parts = []
    for index, (name, qualified, keys) in enumerate(tables):
        key = 'md5(row(%s)::text)' % keys if keys else 'md5(t::text)'
        parts.append("select %d, %s, md5(t::text) from %s t" % (index, key, qualified))
    rows = {name: ({} if keys else collections.Counter()) for name, _, keys in tables}
    if parts:
        for line in pg.read_only('\nunion all\n'.join(parts), db).splitlines():
            if not line:
                continue
            index, key, value = line.split('|')
            name, _, keys = tables[int(index)]
            if keys:
                rows[name][key] = value
            else:
                rows[name][value] += 1
    sequences = {}
    for line in pg.read_only("select schemaname || '.' || sequencename, coalesce(last_value::text, '') "
                             "from pg_sequences order by 1", db).splitlines():
        if line:
            name, value = line.split('|')
            sequences[name] = value
    return {'rows': rows, 'sequences': sequences, 'schema': pg.schema(db)}


def compare(live, other):
    """Public difference report (table names and counts only)."""
    differences = {}
    for name in sorted(set(live['rows']) | set(other['rows'])):
        a, b = live['rows'].get(name), other['rows'].get(name)
        if a is None or b is None:
            differences[name] = {'missing_table': 'restored' if b is None else 'live'}
            continue
        if isinstance(a, collections.Counter) or isinstance(b, collections.Counter):
            a, b = collections.Counter(a), collections.Counter(b)
            entry = {'only_live': sum((a - b).values()), 'only_restored': sum((b - a).values()), 'changed': 0}
        else:
            entry = {'only_live': len(set(a) - set(b)), 'only_restored': len(set(b) - set(a)),
                     'changed': sum(1 for k in set(a) & set(b) if a[k] != b[k])}
        if any(entry.values()):
            differences[name] = entry
    sequences = sorted(k for k in set(live['sequences']) | set(other['sequences'])
                       if live['sequences'].get(k) != other['sequences'].get(k))
    return {'equal': not differences and not sequences and live['schema'] == other['schema'],
            'differences': differences, 'sequences_differ': sequences,
            'schema_equal': live['schema'] == other['schema'],
            'tables': len(live['rows']), 'rows': sum(sum(v.values()) if isinstance(v, collections.Counter) else len(v)
                                                     for v in live['rows'].values())}
