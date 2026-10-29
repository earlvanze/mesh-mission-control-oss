import os, tempfile, unittest
from unittest.mock import patch
os.environ['MMC_HOME'] = tempfile.mkdtemp()
import agent, config, discover, probe

class ConfigTest(unittest.TestCase):
    def test_hosts_round_trip_and_validation(self):
        config.save_hosts([])
        config.add_host({'name': 'box', 'address': '192.168.1.5', 'user': 'me', 'port': 2222})
        self.assertEqual(config.load_hosts(), [{'name': 'box', 'address': '192.168.1.5', 'user': 'me', 'port': 2222}])
        config.remove_host('box'); self.assertEqual(config.load_hosts(), [])
    def test_rejects_option_injection_and_bad_values(self):
        for bad in ({'name': '-oProxyCommand=x', 'address': 'a'}, {'name': 'a', 'address': '-oProxyCommand=x'}, {'name': 'a', 'address': 'h', 'user': '-x'},
                    {'name': 'a', 'address': 'h', 'port': 70000}, {'name': 'a', 'address': 'h', 'key': '-i'}, {'name': 'a b', 'address': 'h'}):
            with self.assertRaises(ValueError): config.clean_host(bad)
    def test_token_is_private_and_stable(self):
        first = config.token(); self.assertEqual(first, config.token())
        self.assertEqual(os.stat(config.HOME / 'token').st_mode & 0o777, 0o600)

class AgentTest(unittest.TestCase):
    @patch('agent.process_args')
    @patch('agent.subprocess.run')
    def test_harnesses_by_name_and_interpreter_script(self, run, args):
        uid = os.getuid()
        run.return_value.stdout = f'{uid} S 1 0 hermes\n{uid} S 2 0 opencode\n{uid} S 3 0 node\n{uid} S 4 3 node\n{uid} S 5 0 node\n{uid} S 6 0 zcode\n'
        scripts = {3: ['node', '/x/node_modules/@mariozechner/pi-coding-agent/dist/cli.js'], 4: ['node', '/x/pi-coding-agent/dist/cli.js'], 5: ['node', 'server.js']}
        args.side_effect = lambda pid: scripts[pid]
        result = agent.local_presence()
        self.assertEqual(result['counts'], {'Hermes': 1, 'OpenCode': 1, 'Pi': 1, 'ZCode': 1})

class ProbeTest(unittest.TestCase):
    def test_local_probe_reports_ok(self):
        self.assertEqual(probe.probe({'name': 'me', 'address': 'local'})['status'], 'ok')
    def test_ssh_argv_pins_known_hosts_file_and_never_prompts(self):
        argv = probe.ssh_argv({'name': 'a', 'address': '10.0.0.2', 'user': 'u', 'port': 22, 'key': '/k'}, 'cmd')
        self.assertIn('BatchMode=yes', argv); self.assertIn('u@10.0.0.2', argv); self.assertEqual(argv[-1], 'cmd')
    def test_peek_masks_secrets_and_rejects_bad_targets(self):
        import peek_agent
        self.assertEqual(peek_agent.clean('\x1b[31mok\x1b[0m token=abcdef123456 ghp_' + 'a' * 30), ['ok [masked] [masked]'])
        with self.assertRaises(ValueError): probe.peek({'name': 'a', 'address': 'local'}, None, 'a;b')

class DiscoverTest(unittest.TestCase):
    @patch('discover.subprocess.run')
    def test_tailnet_skips_phones_and_offers_online_first(self, run):
        run.return_value.stdout = '{"Peer":{"a":{"HostName":"pixel","OS":"android","TailscaleIPs":["100.1.1.1"],"Online":true},"b":{"HostName":"srv","OS":"linux","TailscaleIPs":["100.1.1.2","fd7a::1"],"Online":true}}}'
        self.assertEqual([c['name'] for c in discover.tailnet()], ['srv'])

if __name__ == '__main__': unittest.main()
