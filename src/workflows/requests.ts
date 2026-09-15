/** Domain triggers commit workflow requests with their protected state changes. */
export const workflowRequestSchema=`
CREATE TABLE IF NOT EXISTS workflow_request_revisions (
 family text NOT NULL REFERENCES workflow_owners(family),job_id text NOT NULL,generation integer NOT NULL,
 PRIMARY KEY(family,job_id)
);
CREATE OR REPLACE FUNCTION nocheh_workflow_request(f text,j text,g integer DEFAULT 1) RETURNS text LANGUAGE plpgsql AS $$
DECLARE identity text;
BEGIN
 identity:=encode(sha256(convert_to('['||to_json(f)::text||','||to_json(j)::text||',1,'||g::text||']','UTF8')),'hex');
 INSERT INTO workflow_registry(id,family,job_id,version,generation) VALUES(identity,f,j,1,g) ON CONFLICT DO NOTHING;
 INSERT INTO workflow_outbox(id,workflow_id,dispatch) VALUES(encode(sha256(convert_to(identity||':1','UTF8')),'hex'),identity,1) ON CONFLICT DO NOTHING;
 RETURN identity;
END $$;
CREATE OR REPLACE FUNCTION nocheh_workflow_touch(f text,j text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE next_generation integer;
BEGIN
 INSERT INTO workflow_request_revisions(family,job_id,generation)
 VALUES(f,j,coalesce((SELECT max(generation) FROM workflow_registry WHERE family=f AND job_id=j),0)+1)
 ON CONFLICT(family,job_id) DO UPDATE SET generation=greatest(workflow_request_revisions.generation+1,
 coalesce((SELECT max(generation) FROM workflow_registry WHERE family=f AND job_id=j),0)+1)
 RETURNING generation INTO next_generation;
 UPDATE workflow_registry SET state='skipped',waiting_reason='superseded',updated_at=now(),revision=workflow_registry.revision+1
 WHERE family=f AND job_id=j AND generation<next_generation AND state IN ('queued','waiting','retryable_failed');
 RETURN nocheh_workflow_request(f,j,next_generation);
END $$;
CREATE OR REPLACE FUNCTION nocheh_workflow_domain_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent text;
BEGIN
 IF TG_TABLE_NAME='guard_sources' THEN
   parent:=NEW.event_id;
   IF TG_OP='INSERT' THEN PERFORM nocheh_workflow_touch('preparation',parent); END IF;
   IF NEW.state='ready' THEN
     UPDATE memory_learning_sources SET prepared=false WHERE event_id=parent;
     IF EXISTS(SELECT 1 FROM memory_learning_sources WHERE event_id=parent) THEN
       PERFORM nocheh_workflow_touch('memory_review','source:'||parent);
       PERFORM nocheh_workflow_touch('honcho','refresh');
     END IF;
   END IF;
 ELSIF TG_TABLE_NAME='artifacts' THEN
   PERFORM nocheh_workflow_touch('preparation',NEW.event_id);
 ELSIF TG_TABLE_NAME IN ('dispatches','managed_runs') THEN
   IF NEW.state='done' THEN PERFORM nocheh_workflow_touch('memory_review','source:'||NEW.event_id); END IF;
 ELSIF TG_TABLE_NAME='memory_learning_sources' THEN
   PERFORM nocheh_workflow_touch('memory_review','source:'||NEW.event_id);
   PERFORM nocheh_workflow_touch('honcho','refresh');
 ELSIF TG_TABLE_NAME='memory_review_jobs' THEN
   PERFORM nocheh_workflow_request('memory_review','review:'||NEW.id,NEW.generation+1);
 ELSIF TG_TABLE_NAME='honcho_receipts' THEN
   IF TG_OP='INSERT' THEN
     PERFORM nocheh_workflow_request('honcho','receipt:'||NEW.id);
   ELSIF NEW.state='uncertain' THEN
     PERFORM nocheh_workflow_request('honcho','reconcile:'||NEW.id);
   END IF;
   -- A generation can become busy again after its first observer completed.
   -- New observation identities never reopen a completed ingestion effect.
   IF TG_OP='INSERT' OR NEW.state='done' THEN
     PERFORM nocheh_workflow_touch('honcho','generation:'||NEW.generation);
   END IF;
 ELSIF TG_TABLE_NAME='honcho_generations' THEN
   PERFORM nocheh_workflow_request('honcho','generation:'||NEW.id);
 ELSE
   PERFORM nocheh_workflow_touch('honcho','refresh');
   IF TG_TABLE_NAME<>'honcho_connection' THEN PERFORM nocheh_workflow_touch('memory_review','refresh'); END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workflow_source_added ON guard_sources;
CREATE TRIGGER workflow_source_added AFTER INSERT ON guard_sources FOR EACH ROW EXECUTE FUNCTION nocheh_workflow_domain_change();
DROP TRIGGER IF EXISTS workflow_source_ready ON guard_sources;
CREATE TRIGGER workflow_source_ready AFTER UPDATE OF state,active_revision ON guard_sources FOR EACH ROW
 WHEN (NEW.state='ready' AND (OLD.state IS DISTINCT FROM NEW.state OR OLD.active_revision IS DISTINCT FROM NEW.active_revision)) EXECUTE FUNCTION nocheh_workflow_domain_change();
DROP TRIGGER IF EXISTS workflow_bytes_ready ON artifacts;
CREATE TRIGGER workflow_bytes_ready AFTER UPDATE OF state ON artifacts FOR EACH ROW WHEN(NEW.state='ready' AND OLD.state<>'ready') EXECUTE FUNCTION nocheh_workflow_domain_change();
DROP TRIGGER IF EXISTS workflow_live_learning ON dispatches;
CREATE TRIGGER workflow_live_learning AFTER UPDATE OF state ON dispatches FOR EACH ROW WHEN(NEW.state='done' AND OLD.state<>'done') EXECUTE FUNCTION nocheh_workflow_domain_change();
DROP TRIGGER IF EXISTS workflow_live_learning ON managed_runs;
CREATE TRIGGER workflow_live_learning AFTER UPDATE OF state ON managed_runs FOR EACH ROW WHEN(NEW.state='done' AND OLD.state<>'done') EXECUTE FUNCTION nocheh_workflow_domain_change();
DROP TRIGGER IF EXISTS workflow_consent ON memory_learning_sources;
CREATE TRIGGER workflow_consent AFTER INSERT ON memory_learning_sources FOR EACH ROW EXECUTE FUNCTION nocheh_workflow_domain_change();
DROP TRIGGER IF EXISTS workflow_review ON memory_review_jobs;
CREATE TRIGGER workflow_review AFTER INSERT OR UPDATE OF generation ON memory_review_jobs FOR EACH ROW EXECUTE FUNCTION nocheh_workflow_domain_change();
DROP TRIGGER IF EXISTS workflow_honcho_receipt ON honcho_receipts;
CREATE TRIGGER workflow_honcho_receipt AFTER INSERT ON honcho_receipts FOR EACH ROW EXECUTE FUNCTION nocheh_workflow_domain_change();
DROP TRIGGER IF EXISTS workflow_honcho_reconcile ON honcho_receipts;
CREATE TRIGGER workflow_honcho_reconcile AFTER UPDATE OF state ON honcho_receipts FOR EACH ROW WHEN(NEW.state='uncertain' AND OLD.state<>'uncertain') EXECUTE FUNCTION nocheh_workflow_domain_change();
DROP TRIGGER IF EXISTS workflow_honcho_ready ON honcho_receipts;
CREATE TRIGGER workflow_honcho_ready AFTER UPDATE OF state ON honcho_receipts FOR EACH ROW WHEN(NEW.state='done' AND OLD.state<>'done') EXECUTE FUNCTION nocheh_workflow_domain_change();
DROP TRIGGER IF EXISTS workflow_honcho_generation ON honcho_generations;
CREATE TRIGGER workflow_honcho_generation AFTER INSERT ON honcho_generations FOR EACH ROW EXECUTE FUNCTION nocheh_workflow_domain_change();
DROP TRIGGER IF EXISTS workflow_guard_epoch ON guard_state;
CREATE TRIGGER workflow_guard_epoch AFTER UPDATE OF epoch ON guard_state FOR EACH ROW WHEN(NEW.epoch<>OLD.epoch) EXECUTE FUNCTION nocheh_workflow_domain_change();
DROP TRIGGER IF EXISTS workflow_policy_revision ON memory_policy_state;
CREATE TRIGGER workflow_policy_revision AFTER UPDATE OF revision ON memory_policy_state FOR EACH ROW WHEN(NEW.revision<>OLD.revision) EXECUTE FUNCTION nocheh_workflow_domain_change();
DROP TRIGGER IF EXISTS workflow_honcho_connection ON honcho_connection;
CREATE TRIGGER workflow_honcho_connection AFTER UPDATE OF attached,verified,include_history ON honcho_connection FOR EACH ROW
 WHEN(NEW.attached IS DISTINCT FROM OLD.attached OR NEW.verified IS DISTINCT FROM OLD.verified OR NEW.include_history IS DISTINCT FROM OLD.include_history) EXECUTE FUNCTION nocheh_workflow_domain_change();
`;
