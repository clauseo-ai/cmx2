/**
 * the schema, one entry per `pragma user_version`. append only: a shipped entry is never edited,
 * because a database that already ran it will not run it again.
 */
export const MIGRATIONS: readonly string[] = [
	// 1 · m0: sessions
	`create table session (
		id text primary key,
		directory text not null,
		title text not null,
		model text not null,
		session_file text,
		created_at integer not null
	)`,
	// 2 · m0: one telemetry row per assistant step
	`create table step (
		session_id text not null,
		seq integer not null,
		at integer not null,
		model text not null,
		effort text,
		input integer not null,
		cache_read integer not null,
		cache_write integer not null,
		output integer not null,
		cache_read_pct real not null,
		ttft_ms integer,
		duration_ms integer not null,
		tool_calls integer not null,
		tool_names text not null,
		tool_ms integer not null,
		cost real not null,
		stop_reason text not null,
		prefix_hash text not null,
		steered integer not null,
		primary key (session_id, seq)
	)`,
	// 3 · m1: nested calls, refusals, prefix record, per-session dials
	`alter table step add column nested_calls integer not null default 0;
	 alter table step add column calls integer not null default 0;
	 alter table step add column refusal text;
	 alter table step add column prefix_same integer not null default 1;
	 alter table step add column dropped_blocks integer not null default 0;
	 alter table session add column effort text;
	 alter table session add column nudge integer;
	 alter table session add column turn_mode text;
	 alter table session add column cache_ttl text;
	 create table prefix (
		session_id text primary key,
		hash text not null,
		bytes text not null,
		recorded_at integer not null
	 )`,
	// 4 · m2: session metadata for listing, the message projection, pending asks, saved rules, imports
	`alter table session add column updated_at integer;
	 update session set updated_at = created_at;
	 alter table session add column parent_id text;
	 alter table session add column slug text;
	 alter table session add column project_id text;
	 alter table session add column source text not null default 'cmx2';
	 alter table session add column version text;
	 alter table session add column cost real not null default 0;
	 alter table session add column tokens_input integer not null default 0;
	 alter table session add column tokens_output integer not null default 0;
	 alter table session add column tokens_cache_read integer not null default 0;
	 alter table session add column tokens_cache_write integer not null default 0;
	 alter table session add column summary text;
	 create index session_updated_idx on session (updated_at desc, id desc);
	 create index session_created_idx on session (created_at, id);
	 create index session_project_idx on session (project_id, updated_at desc);
	 create index session_directory_idx on session (directory, updated_at desc);
	 create index session_parent_idx on session (parent_id);
	 create table message (
		id text primary key,
		session_id text not null,
		seq integer not null,
		role text not null,
		created_at integer not null,
		completed_at integer,
		model text,
		effort text,
		tokens_input integer not null default 0,
		tokens_output integer not null default 0,
		tokens_cache_read integer not null default 0,
		tokens_cache_write integer not null default 0,
		cost real not null default 0,
		stop_reason text,
		info text not null
	 );
	 create index message_session_seq_idx on message (session_id, seq);
	 create table part (
		id text primary key,
		message_id text not null,
		session_id text not null,
		seq integer not null,
		type text not null,
		data text not null
	 );
	 create index part_message_idx on part (message_id, seq);
	 create index part_session_idx on part (session_id);
	 create table permission (
		id text primary key,
		session_id text not null,
		directory text not null,
		permission text not null,
		patterns text not null,
		metadata text not null,
		always text not null,
		tool text,
		created_at integer not null,
		reply text,
		message text,
		replied_at integer
	 );
	 create index permission_pending_idx on permission (reply, directory);
	 create table question (
		id text primary key,
		session_id text not null,
		directory text not null,
		questions text not null,
		tool text,
		created_at integer not null,
		state text,
		answers text,
		replied_at integer
	 );
	 create index question_pending_idx on question (state, directory);
	 create table permission_rule (
		scope text not null,
		permission text not null,
		pattern text not null,
		action text not null,
		created_at integer not null,
		primary key (scope, permission, pattern)
	 );
	 create table import_run (
		id integer primary key autoincrement,
		source text not null,
		path text not null,
		started_at integer not null,
		finished_at integer,
		sessions integer,
		messages integer,
		parts integer,
		skipped integer
	 )`,
	// 5 · m3: archive instead of delete (rule 15). imported sessions live in the read-only archive.db,
	// so their archived mark is kept here
	`alter table session add column archived_at integer;
	 create index session_archived_idx on session (archived_at);
	 create table archived_import (
		id text primary key,
		archived_at integer not null
	 )`,
	// 6 · m4: poll-only steps (every call only waited), the budget that jobs with notify drive to zero
	`alter table step add column poll_only integer not null default 0`,
	// 7 · m5: agents. one row per agent (a root's row has path /root); the mailbox keeps items until the
	// recipient's transcript has them; escalation and warming are telemetry on the step that carried them
	`create table agent (
		id text primary key,
		root_id text not null,
		parent_id text,
		path text not null,
		name text not null,
		depth integer not null,
		seat text,
		agent_type text,
		model text,
		effort text,
		state text not null,
		cause text,
		previous_state text,
		brief text,
		last_task text,
		last_report text,
		files text,
		options text not null default '{}',
		delivered integer not null default 0,
		trigger_seq integer not null default 0,
		turn_tokens integer not null default 0,
		tokens integer not null default 0,
		respawns integer not null default 0,
		created_at integer not null,
		updated_at integer not null,
		closed_at integer
	 );
	 create index agent_root_idx on agent (root_id, created_at);
	 create index agent_parent_idx on agent (parent_id);
	 create unique index agent_live_path_idx on agent (root_id, path) where state != 'closed';
	 create table mailbox (
		id text primary key,
		to_id text not null,
		root_id text not null,
		seq integer not null,
		kind text not null,
		from_id text,
		from_path text,
		body text not null,
		wake integer not null,
		system integer not null,
		correlation_id text,
		meta text not null default '{}',
		created_at integer not null,
		delivered_at integer,
		delivered_seq integer
	 );
	 create index mailbox_pending_idx on mailbox (to_id, delivered_at, seq);
	 create table agent_metric (
		at integer not null,
		root_id text not null,
		session_id text not null,
		kind text not null,
		child_id text,
		data text not null default '{}'
	 );
	 create index agent_metric_root_idx on agent_metric (root_id, kind, at);
	 alter table step add column escalation text;
	 alter table step add column warm integer not null default 0`,
	// 8 · m5: a step that hit the output limit and went on with a continuation request
	`alter table step add column continued integer not null default 0`,
	// 9 · m6: the event log clients resume from (a1), the epoch that names this store, client ids for
	// idempotent sends and replies (a4), and who settled an ask (a6). the log is a replay window, not
	// history: it is pruned; sessions and messages are never touched by it
	`create table event_log (
		seq integer primary key autoincrement,
		at integer not null,
		directory text not null,
		project text,
		type text not null,
		properties text not null
	 );
	 create index event_log_at_idx on event_log (at);
	 create table meta (
		key text primary key,
		value text not null
	 );
	 insert into meta (key, value) values ('epoch', lower(hex(randomblob(6))));
	 insert into meta (key, value) values ('pruned_through', '0');
	 create table client_action (
		client_id text primary key,
		route text not null,
		session_id text,
		status integer,
		body text,
		created_at integer not null,
		done_at integer
	 );
	 create index client_action_created_idx on client_action (created_at);
	 alter table permission add column settled_by text;
	 alter table question add column settled_by text`,
	// m6 · projects a client opened before any session ran there (boxbox v1's "open a repo"); listed with
	// the projects that have sessions
	`create table project_opened (
		path text primary key,
		opened_at integer not null
	 )`,
	// 11 · m7: per-session state that is not a listing column (context fill, an armed revert), file
	// snapshots per turn, messages a revert took out of the context (marked, never deleted: rule 15),
	// and the recall index: every piece of text a session said, ran or read, whole, searched with fts5
	`create table session_state (
		session_id text primary key,
		context_used integer,
		context_limit integer,
		compact_at integer,
		revert text
	 );
	 create table turn_snapshot (
		session_id text not null,
		from_seq integer not null,
		to_seq integer,
		before text not null,
		after text,
		files text,
		at integer not null,
		primary key (session_id, from_seq)
	 );
	 alter table message add column reverted integer not null default 0;
	 create table recall_doc (
		id text primary key,
		session_id text not null,
		message_id text not null,
		seq integer not null,
		role text not null,
		kind text not null,
		tool text,
		call_id text,
		at integer not null,
		text text not null
	 );
	 create index recall_doc_session_idx on recall_doc (session_id, seq);
	 create virtual table recall_fts using fts5(text, content='recall_doc', content_rowid='rowid');
	 create trigger recall_doc_ai after insert on recall_doc begin
		insert into recall_fts (rowid, text) values (new.rowid, new.text);
	 end;
	 create trigger recall_doc_ad after delete on recall_doc begin
		insert into recall_fts (recall_fts, rowid, text) values ('delete', old.rowid, old.text);
	 end;
	 create trigger recall_doc_au after update on recall_doc begin
		insert into recall_fts (recall_fts, rowid, text) values ('delete', old.rowid, old.text);
		insert into recall_fts (rowid, text) values (new.rowid, new.text);
	 end`,
	// 12 · putRecall deletes a message's rows before it writes them again; without this index that is a scan of
	// the whole recall table, on the main thread, for every message projected
	`create index recall_doc_message_idx on recall_doc (message_id)`,
	// 13 · the transcript revision (boxbox protocol 14a): a per-session counter every transcript write moves, and the
	// revision each logged message or session event carried. existing sessions start at 0: no client has seen a revision
	// before this column, and it only grows from here
	`alter table session add column transcript_rev integer not null default 0;
	 alter table event_log add column rev integer`,
	// 14 · fork lineage: the session a fork was made from and the parent's message it was cut before (null when the whole
	// history was forked). not parent_id, which clients read as "an agent spawned by". existing rows keep null
	`alter table session add column forked_from text;
	 alter table session add column forked_at_message text`,
];
