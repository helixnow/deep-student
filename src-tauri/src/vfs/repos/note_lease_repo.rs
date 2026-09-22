//! Notes-only cross-WebView freeze barrier and transactional write fence.
//! No serialized-map comparisons: ACKs compare typed complete Markdown drafts.
use super::{note_format_repo::{conflict, invalid}, note_repo::VfsNoteRepo,
    note_revision_repo::NoteRevisionRepo};
use crate::vfs::error::VfsResult;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const PARTICIPANT_TTL: i64 = 45;
pub const LEASE_TTL: i64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FrozenDraft {
    pub markdown: String,
    pub expected_updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteLeaseAuth {
    pub participant_id: String,
    pub token: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct LeaseNote {
    pub note_id: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct LeaseStatus {
    pub token: String,
    pub operation_id: String,
    pub owner_id: String,
    pub phase: String,
    pub expires_at: i64,
    pub notes: Vec<LeaseNote>,
    pub waiting_for: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct ParticipantStatus {
    pub participant_id: String,
    pub expires_at: i64,
    pub active_lease: Option<LeaseStatus>,
}
#[derive(Debug, Clone, Serialize)]
pub struct LeaseCancellation {
    pub token: String,
    pub note_ids: Vec<String>,
    pub reason: String,
}

pub struct NoteLeaseRepo;
impl NoteLeaseRepo {
    pub fn now() -> i64 { chrono::Utc::now().timestamp() }

    fn participant(conn: &Connection, id: &str, webview: &str, now: i64) -> VfsResult<String> {
        conn.query_row("SELECT note_id FROM note_editor_participants WHERE id=?1 AND webview_label=?2 AND expires_at>?3",
            params![id,webview,now], |r| r.get(0)).optional()?
            .ok_or_else(|| conflict("notes.participant_expired"))
    }

    pub fn status(conn: &Connection, token: &str) -> VfsResult<Option<LeaseStatus>> {
        let row: Option<(String,String,String,i64)> = conn.query_row(
            "SELECT operation_id,owner_id,phase,expires_at FROM note_editor_leases WHERE token=?1",[token],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some((operation_id,owner_id,phase,expires_at)) = row else { return Ok(None) };
        let mut stmt=conn.prepare("SELECT ln.note_id,n.updated_at FROM note_editor_lease_notes ln JOIN notes n ON n.id=ln.note_id WHERE ln.token=?1 ORDER BY ln.note_id")?;
        let notes=stmt.query_map([token], |r| Ok(LeaseNote{note_id:r.get(0)?,updated_at:r.get(1)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut stmt=conn.prepare("SELECT participant_id FROM note_editor_lease_acks WHERE token=?1 AND CASE WHEN ?2='refreshing' THEN refreshed=0 ELSE draft_json IS NULL END ORDER BY participant_id")?;
        let waiting_for=stmt.query_map(params![token,phase], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Some(LeaseStatus{token:token.into(),operation_id,owner_id,phase,expires_at,notes,waiting_for}))
    }

    fn required(conn: &Connection, token: &str, now: i64) -> VfsResult<LeaseStatus> {
        let status=Self::status(conn,token)?.ok_or_else(|| conflict("notes.lease_expired"))?;
        let dead: bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM note_editor_lease_acks a LEFT JOIN note_editor_participants p ON p.id=a.participant_id WHERE a.token=?1 AND (p.id IS NULL OR p.expires_at<=?2))",params![token,now],|r|r.get(0))?;
        if status.expires_at<=now || dead { return Err(conflict("notes.lease_expired")); }
        Ok(status)
    }

    fn owned(conn: &Connection, auth: &NoteLeaseAuth, webview: &str, now: i64) -> VfsResult<LeaseStatus> {
        Self::participant(conn,&auth.participant_id,webview,now)?;
        let status=Self::required(conn,&auth.token,now)?;
        if status.owner_id!=auth.participant_id { return Err(conflict("notes.lease_owner_mismatch")); }
        Ok(status)
    }

    pub fn register(conn: &Connection, note_id: &str, webview: &str, window: &str, now: i64) -> VfsResult<ParticipantStatus> {
        NoteRevisionRepo::transaction(conn,|| {
            if VfsNoteRepo::get_note_with_conn(conn,note_id)?.is_none() { return Err(invalid("Note missing")); }
            let id=format!("nep_{}",uuid::Uuid::new_v4().simple());
            conn.execute("INSERT INTO note_editor_participants VALUES(?1,?2,?3,?4,?5)",params![id,webview,window,note_id,now+PARTICIPANT_TTL])?;
            let token:Option<String>=conn.query_row("SELECT token FROM note_editor_lease_notes WHERE note_id=?1",[note_id],|r|r.get(0)).optional()?;
            let active_lease=if let Some(token)=token {
                conn.execute("INSERT INTO note_editor_lease_acks(token,participant_id) VALUES(?1,?2)",params![token,id])?;
                // A new editor joins the barrier before any subsequent flush/commit.
                conn.execute("UPDATE note_editor_leases SET phase='pending',expires_at=MIN(expires_at,?2) WHERE token=?1 AND phase='ready'",params![token,now+LEASE_TTL])?;
                Self::status(conn,&token)?
            } else {None};
            Ok(ParticipantStatus{participant_id:id,expires_at:now+PARTICIPANT_TTL,active_lease})
        })
    }

    pub fn heartbeat(conn:&Connection,id:&str,webview:&str,now:i64)->VfsResult<ParticipantStatus> {
        NoteRevisionRepo::transaction(conn,|| {
            let note_id=Self::participant(conn,id,webview,now)?;
            conn.execute("UPDATE note_editor_participants SET expires_at=?2 WHERE id=?1",params![id,now+PARTICIPANT_TTL])?;
            // Pending ACKs have a fixed deadline; heartbeats cannot wait forever.
            conn.execute("UPDATE note_editor_leases SET expires_at=?2 WHERE owner_id=?1 AND expires_at>?3 AND phase!='pending'",params![id,now+LEASE_TTL,now])?;
            let token:Option<String>=conn.query_row("SELECT token FROM note_editor_lease_notes WHERE note_id=?1",[note_id],|r|r.get(0)).optional()?;
            Ok(ParticipantStatus{participant_id:id.into(),expires_at:now+PARTICIPANT_TTL,active_lease:token.map(|t|Self::status(conn,&t)).transpose()?.flatten()})
        })
    }

    pub fn begin(conn:&Connection,owner:&str,webview:&str,operation_id:&str,note_ids:Vec<String>,now:i64)->VfsResult<LeaseStatus> {
        NoteRevisionRepo::transaction(conn,|| {
            Self::participant(conn,owner,webview,now)?;
            let ids: BTreeSet<_>=note_ids.into_iter().collect();
            if ids.is_empty() || operation_id.trim().is_empty() { return Err(invalid("Operation and note IDs required")); }
            if let Some(token)=conn.query_row("SELECT token FROM note_editor_leases WHERE operation_id=?1",[operation_id],|r|r.get::<_,String>(0)).optional()? {
                let status=Self::owned(conn,&NoteLeaseAuth{participant_id:owner.into(),token},webview,now)?;
                if status.notes.iter().map(|n|n.note_id.clone()).collect::<BTreeSet<_>>()!=ids {return Err(conflict("notes.lease_operation_mismatch"));}
                return Ok(status);
            }
            let token=format!("nel_{}",uuid::Uuid::new_v4().simple());
            conn.execute("INSERT INTO note_editor_leases VALUES(?1,?2,?3,'pending',?4)",params![token,operation_id,owner,now+LEASE_TTL])?;
            for id in ids {
                if VfsNoteRepo::get_note_with_conn(conn,&id)?.is_none() {return Err(invalid("Note missing"));}
                if conn.query_row("SELECT EXISTS(SELECT 1 FROM note_editor_lease_notes WHERE note_id=?1)",[&id],|r|r.get::<_,bool>(0))? {return Err(conflict("notes.lease_conflict"));}
                conn.execute("INSERT INTO note_editor_lease_notes VALUES(?1,?2)",params![id,token])?;
                conn.execute("INSERT INTO note_editor_lease_acks(token,participant_id) SELECT ?1,id FROM note_editor_participants WHERE note_id=?2 AND expires_at>?3",params![token,id,now])?;
            }
            // The owner must be among the editors covered by this lease.
            if !conn.query_row("SELECT EXISTS(SELECT 1 FROM note_editor_lease_acks WHERE token=?1 AND participant_id=?2)",params![token,owner],|r|r.get::<_,bool>(0))? {return Err(invalid("Owner note must be in note_ids"));}
            Self::status(conn,&token)?.ok_or_else(|| invalid("Lease missing"))
        })
    }

    pub fn ack(conn:&Connection,auth:&NoteLeaseAuth,webview:&str,draft:FrozenDraft,now:i64)->VfsResult<LeaseStatus> {
        NoteRevisionRepo::transaction(conn,|| {
            let note_id=Self::participant(conn,&auth.participant_id,webview,now)?;
            let status=Self::required(conn,&auth.token,now)?;
            if status.phase!="pending" && status.phase!="ready" {return Err(conflict("notes.lease_phase"));}
            let current=VfsNoteRepo::get_note_with_conn(conn,&note_id)?.ok_or_else(|| invalid("Note missing"))?;
            if draft.expected_updated_at!=current.updated_at {return Err(conflict("notes.lease_stale_draft"));}
            // ACKs are immutable until flush updates their agreed OCC baseline.
            let mut stmt=conn.prepare("SELECT a.draft_json FROM note_editor_lease_acks a JOIN note_editor_participants p ON p.id=a.participant_id WHERE a.token=?1 AND p.note_id=?2 AND a.draft_json IS NOT NULL")?;
            let previous=stmt.query_map(params![auth.token,note_id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            for raw in previous {
                let previous:FrozenDraft=serde_json::from_str(&raw).map_err(|e| invalid(&e.to_string()))?;
                if previous!=draft {return Err(conflict("notes.lease_divergent_drafts"));}
            }
            let raw=serde_json::to_string(&draft).map_err(|e|invalid(&e.to_string()))?;
            if conn.execute("UPDATE note_editor_lease_acks SET draft_json=?3 WHERE token=?1 AND participant_id=?2",params![auth.token,auth.participant_id,raw])?!=1 {return Err(conflict("notes.lease_participant_mismatch"));}
            conn.execute("UPDATE note_editor_leases SET phase='ready' WHERE token=?1 AND NOT EXISTS(SELECT 1 FROM note_editor_lease_acks WHERE token=?1 AND draft_json IS NULL)",[&auth.token])?;
            Self::required(conn,&auth.token,now)
        })
    }

    /// Called inside the same savepoint as the body write. SQL triggers are the
    /// backstop for raw SQL, DSTU, AI, sync and non-command callers.
    pub(crate) fn check_write(conn:&Connection,note_id:&str)->VfsResult<()> {
        if conn.query_row("SELECT EXISTS(SELECT 1 FROM note_editor_lease_notes ln WHERE ln.note_id=?1 AND NOT EXISTS(SELECT 1 FROM note_editor_write_grants g WHERE g.token=ln.token))",[note_id],|r|r.get::<_,bool>(0))? {return Err(conflict("notes.lease_conflict"));}
        Ok(())
    }

    pub fn authorized<T>(conn:&Connection,auth:&NoteLeaseAuth,webview:&str,now:i64,commit:bool,work:impl FnOnce()->VfsResult<T>)->VfsResult<T> {
        NoteRevisionRepo::transaction(conn,|| {
            // Acquire SQLite's writer lock before inspecting the barrier.
            conn.execute("INSERT INTO note_editor_write_grants VALUES(?1)",[&auth.token])?;
            let status=Self::owned(conn,auth,webview,now)?;
            if status.phase!="ready" {return Err(conflict("notes.lease_not_ready"));}
            if commit {
                let mut stmt=conn.prepare("SELECT p.note_id,a.draft_json FROM note_editor_lease_acks a JOIN note_editor_participants p ON p.id=a.participant_id WHERE a.token=?1")?;
                let drafts=stmt.query_map([&auth.token],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                for (id,raw) in drafts {
                    let draft:FrozenDraft=serde_json::from_str(&raw).map_err(|e|invalid(&e.to_string()))?;
                    let current=NoteRevisionRepo::current(conn,&id)?;
                    if current.content_md!=draft.markdown || current.updated_at!=draft.expected_updated_at {return Err(conflict("notes.lease_flush_required"));}
                }
            }
            let result=work()?;
            if commit {
                for note in &status.notes {
                    let current=NoteRevisionRepo::current(conn,&note.note_id)?;
                    let draft=FrozenDraft{markdown:current.content_md,expected_updated_at:current.updated_at};
                    let raw=serde_json::to_string(&draft).map_err(|e|invalid(&e.to_string()))?;
                    conn.execute("UPDATE note_editor_lease_acks SET draft_json=?3 WHERE token=?1 AND participant_id IN (SELECT id FROM note_editor_participants WHERE note_id=?2)",params![auth.token,note.note_id,raw])?;
                }
            }
            conn.execute("DELETE FROM note_editor_write_grants WHERE token=?1",[&auth.token])?;
            Ok(result)
        })
    }

    pub fn finish(conn:&Connection,auth:&NoteLeaseAuth,webview:&str,now:i64)->VfsResult<LeaseStatus> {
        NoteRevisionRepo::transaction(conn,|| {
            let status=Self::owned(conn,auth,webview,now)?;
            if status.phase!="ready" {return Err(conflict("notes.lease_not_ready"));}
            conn.execute("UPDATE note_editor_leases SET phase='refreshing',expires_at=?2 WHERE token=?1",params![auth.token,now+LEASE_TTL])?;
            Self::required(conn,&auth.token,now)
        })
    }

    /// Flush only the exact complete draft agreed by every editor for this note.
    /// It cannot be used as an unrestricted write capability before commit.
    pub fn flush(conn:&Connection,auth:&NoteLeaseAuth,webview:&str,note_id:&str,capabilities:&[String],now:i64)->VfsResult<LeaseNote> {
        Self::authorized(conn,auth,webview,now,false,|| {
            let raw:Option<String>=conn.query_row("SELECT a.draft_json FROM note_editor_lease_acks a JOIN note_editor_participants p ON p.id=a.participant_id WHERE a.token=?1 AND p.note_id=?2 LIMIT 1",params![auth.token,note_id],|r|r.get(0)).optional()?.flatten();
            let Some(raw)=raw else {
                if !Self::required(conn,&auth.token,now)?.notes.iter().any(|note|note.note_id==note_id) {return Err(conflict("notes.lease_scope"));}
                let current=NoteRevisionRepo::current(conn,note_id)?;
                return Ok(LeaseNote{note_id:note_id.into(),updated_at:current.updated_at});
            };
            let mut draft:FrozenDraft=serde_json::from_str(&raw).map_err(|e|invalid(&e.to_string()))?;
            let current=NoteRevisionRepo::current(conn,note_id)?;
            let note=if current.content_md==draft.markdown && current.updated_at==draft.expected_updated_at {
                VfsNoteRepo::get_note_with_conn(conn,note_id)?.ok_or_else(||invalid("Note missing"))?
            } else {
                VfsNoteRepo::update_note_with_capabilities(conn,note_id,crate::vfs::types::VfsUpdateNoteParams{content:Some(draft.markdown.clone()),expected_updated_at:Some(draft.expected_updated_at.clone()),..Default::default()},capabilities)?
            };
            draft.expected_updated_at=note.updated_at.clone();
            let raw=serde_json::to_string(&draft).map_err(|e|invalid(&e.to_string()))?;
            conn.execute("UPDATE note_editor_lease_acks SET draft_json=?3 WHERE token=?1 AND participant_id IN (SELECT id FROM note_editor_participants WHERE note_id=?2)",params![auth.token,note_id,raw])?;
            Ok(LeaseNote{note_id:note.id,updated_at:note.updated_at})
        })
    }

    pub fn refresh_ack(conn:&Connection,auth:&NoteLeaseAuth,webview:&str,updated_at:&str,now:i64)->VfsResult<LeaseStatus> {
        NoteRevisionRepo::transaction(conn,|| {
            let note_id=Self::participant(conn,&auth.participant_id,webview,now)?;
            let status=Self::required(conn,&auth.token,now)?;
            if status.phase!="refreshing" {return Err(conflict("notes.lease_phase"));}
            if !status.notes.iter().any(|n|n.note_id==note_id && n.updated_at==updated_at) {return Err(conflict("notes.lease_stale_refresh"));}
            if conn.execute("UPDATE note_editor_lease_acks SET refreshed=1 WHERE token=?1 AND participant_id=?2",params![auth.token,auth.participant_id])?!=1 {return Err(conflict("notes.lease_participant_mismatch"));}
            Self::required(conn,&auth.token,now)
        })
    }

    pub fn release(conn:&Connection,auth:&NoteLeaseAuth,webview:&str,cancel:bool,now:i64)->VfsResult<LeaseCancellation> {
        NoteRevisionRepo::transaction(conn,|| {
            let status=Self::owned(conn,auth,webview,now)?;
            if !cancel && (status.phase!="refreshing" || !status.waiting_for.is_empty()) {return Err(conflict("notes.lease_refresh_pending"));}
            Self::remove(conn,&auth.token,if cancel {"cancelled"} else {"released"})
        })
    }

    pub(crate) fn remove(conn:&Connection,token:&str,reason:&str)->VfsResult<LeaseCancellation> {
        let status=Self::status(conn,token)?;
        conn.execute("DELETE FROM note_editor_lease_acks WHERE token=?1",[token])?;
        conn.execute("DELETE FROM note_editor_lease_notes WHERE token=?1",[token])?;
        conn.execute("DELETE FROM note_editor_write_grants WHERE token=?1",[token])?;
        conn.execute("DELETE FROM note_editor_leases WHERE token=?1",[token])?;
        Ok(LeaseCancellation{token:token.into(),note_ids:status.map(|s|s.notes.into_iter().map(|n|n.note_id).collect()).unwrap_or_default(),reason:reason.into()})
    }

    /// Expired/closed participants cancel the whole barrier; never silently
    /// shrink its quorum and authorize an overwrite of an unreported draft.
    pub fn cleanup(conn:&Connection,now:i64,window:Option<&str>,webview:Option<&str>)->VfsResult<Vec<LeaseCancellation>> {
        NoteRevisionRepo::transaction(conn,|| {
            conn.execute("DELETE FROM note_editor_participants WHERE expires_at<=?1 OR window_label=?2 OR webview_label=?3",params![now,window,webview])?;
            let mut stmt=conn.prepare("SELECT token FROM note_editor_leases l WHERE expires_at<=?1 OR NOT EXISTS(SELECT 1 FROM note_editor_participants p WHERE p.id=l.owner_id) OR EXISTS(SELECT 1 FROM note_editor_lease_acks a WHERE a.token=l.token AND NOT EXISTS(SELECT 1 FROM note_editor_participants p WHERE p.id=a.participant_id))")?;
            let tokens=stmt.query_map([now],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            tokens.iter().map(|t|Self::remove(conn,t,"participant_closed_or_expired")).collect()
        })
    }

    pub fn unregister(conn:&Connection,id:&str,webview:&str,now:i64)->VfsResult<Vec<LeaseCancellation>> {
        NoteRevisionRepo::transaction(conn,|| {
            conn.execute("DELETE FROM note_editor_participants WHERE id=?1 AND webview_label=?2",params![id,webview])?;
            Self::cleanup(conn,now,None,None)
        })
    }
}

#[cfg(test)]
#[path="note_lease_tests.rs"]
mod tests;
