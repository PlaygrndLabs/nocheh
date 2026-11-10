import unittest
from tools.operations.archive.knowledge import allowed_path


class KnowledgeToolsTests(unittest.TestCase):
    def test_owner_proxy_only_adds_named_management_resources(self):
        identity='a'*64
        for path in ('/v1/conversations','/v1/conversations/context?space=-10','/v1/decisions',
                     '/v1/decisions/controlled_action/'+identity,'/v1/decisions/telegram_action/'+identity,
                     '/v1/projects/'+identity+'/context','/v1/organization/delegations',
                     '/v1/organization/delegations/'+identity+'/resume','/v1/knowledge/proposals',
                     '/v1/knowledge/proposals/'+identity+'/decide','/v1/knowledge/proposals/'+identity+'/undo',
                     '/v1/prompts','/v1/entities/claims/'+identity+'/history?before=3',
                     '/v1/tasks?state=done','/v1/tasks/'+identity,'/v1/tasks/settings','/v1/tasks/archive-finished',
                     '/v1/tasks/'+identity+'/comments','/v1/tasks/'+identity+'/delete'):
            self.assertTrue(allowed_path(path),path)
        for path in ('/v1/decisions/unknown/'+identity,'/v1/knowledge/proposals/'+identity+'/execute',
                     '/v1/knowledge/proposals/'+identity+'/../secrets','/v1/organization/activate',
                     '/v1/conversations/refresh','/v1/security/transport','/v1/tasks/'+identity+'/purge',
                     '/v1/tasks/settings/'+identity):
            self.assertFalse(allowed_path(path),path)


if __name__=='__main__':unittest.main()
