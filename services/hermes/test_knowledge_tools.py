import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from . import archive_tools, knowledge_tools
from .assistant_turn import ALLOWED_TOOLS
from tools.operations.archive.knowledge import allowed_path


class KnowledgeToolsTests(unittest.TestCase):
    def test_tools_use_exact_scoped_routes_and_preserve_proposal_content(self):
        identity='a'*64
        proposal={'operation_id':'synthetic-proposal','proposal':{'kind':'organization','reason':'Organize the selected project',
            'creates':[{'key':'project','name':'Example','evidence_ids':['b'*64]}],'assignments':[]}}
        with patch.object(archive_tools,'request',return_value={'id':identity,'state':'review'}) as request:
            self.assertEqual(json.loads(knowledge_tools.propose_tool(proposal))['state'],'review')
            request.assert_called_once_with('/v1/knowledge/proposals',proposal)
            request.reset_mock()
            self.assertEqual(json.loads(knowledge_tools.status_tool({'id':identity}))['state'],'review')
            request.assert_called_once_with('/v1/knowledge/proposals/'+identity,None)
            request.reset_mock()
            knowledge_tools.inspect_tool({'space':'-100/topic/8','q':'Two words','after':identity})
            request.assert_called_once_with('/v1/knowledge/context?space=-100%2Ftopic%2F8&q=Two+words&after='+identity,None)
            request.reset_mock()
            knowledge_tools.inspect_tool({'entity_id':identity,'claims_after':'b'*64})
            request.assert_called_once_with('/v1/knowledge/context?entity_id='+identity+'&claims_after='+'b'*64,None)

    def test_no_model_selected_identity_credential_or_route_is_forwarded(self):
        with patch.object(archive_tools,'request') as request:
            for args in ({'id':'../delegations'},{'id':'a'*64,'credential':'secret'},{'id':'a'*64,'owner':True}):
                self.assertIn('error',json.loads(knowledge_tools.status_tool(args)))
            for args in ({'scope':'owner'},{'url':'/v1/projects'},{'q':False}):
                self.assertIn('error',json.loads(knowledge_tools.inspect_tool(args)))
            for args in ({'operation_id':'x','proposal':{},'approved':True},{'operation_id':'','proposal':{}},{'proposal':{}}):
                self.assertIn('error',json.loads(knowledge_tools.propose_tool(args)))
            request.assert_not_called()

    def test_errors_are_explicit_and_never_leak_backend_payloads(self):
        error=HTTPError('synthetic',409,'Conflict',{},io.BytesIO(b'{"error":"knowledge_proposal_changed"}'))
        with patch.object(archive_tools,'request',side_effect=error):
            self.assertEqual(json.loads(knowledge_tools.status_tool({'id':'a'*64})),{'error':'knowledge_proposal_changed'})
        error=HTTPError('synthetic',503,'Unavailable',{},io.BytesIO(b'{"error":"private source words"}'))
        with patch.object(archive_tools,'request',side_effect=error):
            self.assertEqual(json.loads(knowledge_tools.inspect_tool({})),{'error':'knowledge_unavailable'})
        with patch.object(archive_tools,'request',return_value={'content':'x'*65000}):
            self.assertEqual(json.loads(knowledge_tools.inspect_tool({})),{'error':'knowledge_response_too_large','partial':True})

    def test_registered_tools_have_closed_typed_contracts(self):
        captured={}
        class Context:
            def register_tool(self,**tool):captured[tool['name']]=tool
        knowledge_tools.register(Context())
        self.assertEqual(set(captured),{'nocheh_knowledge_inspect','nocheh_knowledge_propose','nocheh_knowledge_status'})
        self.assertTrue(set(captured)<=ALLOWED_TOOLS)
        proposal=captured['nocheh_knowledge_propose']['schema']['parameters']
        self.assertFalse(proposal['additionalProperties'])
        self.assertEqual(proposal['required'],['operation_id','proposal'])
        self.assertEqual({branch['properties']['kind']['const'] for branch in proposal['properties']['proposal']['oneOf']},
                         {'organization','project_save','project_assignment','entity_rename','entity_correct','entity_merge','entity_unmerge','sharing_rule','fact_grant','fact_revoke'})
        for branch in proposal['properties']['proposal']['oneOf']:
            self.assertFalse(branch['additionalProperties'])
            self.assertNotIn('approved',branch['properties'])
            self.assertNotIn('delegation_id',branch['properties'])

    def test_owner_proxy_only_adds_named_management_resources(self):
        identity='a'*64
        for path in ('/v1/conversations','/v1/conversations/context?space=-10','/v1/decisions',
                     '/v1/decisions/controlled_action/'+identity,'/v1/decisions/telegram_action/'+identity,
                     '/v1/projects/'+identity+'/context','/v1/organization/delegations',
                     '/v1/organization/delegations/'+identity+'/resume','/v1/knowledge/proposals',
                     '/v1/knowledge/proposals/'+identity+'/decide','/v1/knowledge/proposals/'+identity+'/undo'):
            self.assertTrue(allowed_path(path),path)
        for path in ('/v1/decisions/unknown/'+identity,'/v1/knowledge/proposals/'+identity+'/execute',
                     '/v1/knowledge/proposals/'+identity+'/../secrets','/v1/organization/activate',
                     '/v1/conversations/refresh','/v1/security/transport'):
            self.assertFalse(allowed_path(path),path)


if __name__=='__main__':unittest.main()
