"""Real local HTTP generation -> interrupted downloads -> host output contract."""
import errno
from pathlib import Path
from unittest.mock import patch
from test_plugin import PluginTests, MP4, p


class DownloadRetryTests(PluginTests):
    def assert_one_original_task(self):
        self.assertEqual(self.state['posts'], 1)
        urls = [url for url in self.state['gets'] if url.endswith('/content')]
        self.assertTrue(urls)
        self.assertEqual(set(urls), {'/v1/videos/task_1/content'})
        self.assertEqual(self.rows()[0]['task_id'], 'task_1')
        self.assertFalse(list(self.root.glob('*.part')))

    def test_broken_downloads_recover_within_same_generate_call_and_return_original_slot(self):
        self.state['download_sequence'] = ['truncated', 'disconnect', 503, 'ok']
        events = []
        def callback(*event):
            events.append(event)
            if event[0].startswith('下载重试'):
                self.assertEqual(self.rows()[0]['state'], 'completed')
                self.assertFalse(list(self.root.glob('*.mp4')))
                self.assertFalse(list(self.root.glob('*.part')))
        self.context['progress_callback'] = callback
        with patch.object(p.time, 'sleep') as wait:
            paths = p.generate(self.context)
        self.assertEqual([call.args[0] for call in wait.call_args_list if call.args[0] >= 2][-3:], [2, 5, 10])
        self.assertEqual(paths, [str(self.root/'0002_scene_abc_0_0.mp4')])
        self.assertEqual(Path(paths[0]).read_bytes(), MP4)
        self.assertEqual(self.state['downloads'], 4)
        self.assertEqual(len([e for e in events if e[0].startswith('下载重试')]), 3)
        self.assertEqual(self.rows()[0]['state'], 'downloaded')
        self.assert_one_original_task()
        self.assertEqual(p.generate(self.context), paths)
        self.assertEqual(self.state['downloads'], 4)
        self.assertEqual(self.state['posts'], 1)
        self.assertTrue(all(h.get('Accept-Encoding') == 'identity' for h in self.state['download_headers']))

    def test_exhaustion_preserves_task_and_recovery_downloads_without_new_generation(self):
        self.state['download_sequence'] = ['truncated'] * 4
        with self.assertRaisesRegex(Exception, '已尝试 4 次.*视频下载不完整'):
            p.generate(self.context)
        row = self.rows()[0]
        self.assertEqual(row['state'], 'completed')
        self.assertIn('视频已生成，下载待完成', row['message'])
        self.assertFalse(list(self.root.glob('*.mp4')))
        self.assert_one_original_task()
        self.state['download_sequence'] = [502, 'ok']
        result = p.handle_action('recover', {'params': self.params, 'local_id': row['local_id']})
        self.assertTrue(result['ok'], result)
        self.assertEqual(Path(row['output']).read_bytes(), MP4)
        self.assertEqual(self.state['downloads'], 6)
        self.assert_one_original_task()

    def test_same_slot_after_exhaustion_resumes_original_download(self):
        self.state['download_sequence'] = [503] * 4
        with self.assertRaisesRegex(Exception, 'HTTP 503'):
            p.generate(self.context)
        paths = p.generate(self.context)
        self.assertEqual(Path(paths[0]).read_bytes(), MP4)
        self.assert_one_original_task()

    def test_partial_content_is_retried_instead_of_returned_to_host(self):
        self.state['download_sequence'] = ['partial_range', 'ok']
        paths = p.generate(self.context)
        self.assertEqual(self.state['downloads'], 2)
        self.assertEqual(Path(paths[0]).read_bytes(), MP4)
        self.assert_one_original_task()

    def test_permanent_auth_error_is_not_retried_or_resubmitted(self):
        self.state['download_sequence'] = [401]
        with self.assertRaisesRegex(Exception, 'HTTP 401'):
            p.generate(self.context)
        self.assertEqual(self.state['downloads'], 1)
        self.assertEqual(self.rows()[0]['state'], 'completed')
        self.assert_one_original_task()

    def test_rate_limit_honors_retry_after_for_download_only(self):
        self.state['download_sequence'] = [429, 'ok']
        with patch.object(p.time, 'sleep') as wait:
            p.generate(self.context)
        self.assertIn(3, [call.args[0] for call in wait.call_args_list])
        self.assertEqual(self.state['downloads'], 2)
        self.assert_one_original_task()

    def test_disk_error_keeps_existing_file_and_does_not_retry_network(self):
        target = self.root/'0002_scene_abc_0_0.mp4'
        target.write_bytes(b'existing user file')
        with patch.object(p.os, 'replace', side_effect=OSError(errno.ENOSPC, '磁盘空间不足')):
            with self.assertRaisesRegex(Exception, '磁盘空间不足'):
                p.generate(self.context)
        self.assertEqual(target.read_bytes(), b'existing user file')
        self.assertEqual(self.state['downloads'], 1)
        self.assertEqual(self.rows()[0]['state'], 'completed')
        self.assert_one_original_task()

    def test_shared_deadline_stops_without_another_download(self):
        client = p.Client(self.params)
        with patch.object(p.time, 'monotonic', side_effect=[0, 1, 899]), \
             patch.object(client, '_download_once', side_effect=p.DownloadRetryableError('网络中断')) as attempt:
            with self.assertRaisesRegex(p.PluginError, '未重新生成'):
                client.download('task_existing', str(self.root/'original.mp4'))
        self.assertLessEqual(attempt.call_count, 2)
        self.assertEqual(self.state['posts'], 0)

    def test_two_output_slots_each_generate_once_despite_download_retry(self):
        self.context['output_position'] = [0, 2]
        self.state['download_sequence'] = ['truncated', 'ok', 503, 'ok']
        paths = p.generate(self.context)
        self.assertEqual([Path(path).name for path in paths], ['0002_scene_abc_0_0.mp4', '0002_scene_abc_0_2.mp4'])
        self.assertTrue(all(Path(path).read_bytes() == MP4 for path in paths))
        self.assertEqual(self.state['posts'], 2)
        self.assertEqual(self.state['downloads'], 4)
        self.assertEqual({row['task_id'] for row in self.rows()}, {'task_1', 'task_2'})

    def test_redirect_retry_restarts_original_endpoint_and_never_leaks_credentials(self):
        import io
        import urllib.error
        client = p.Client(self.params)
        seen = []
        cdn_calls = 0
        class Response(io.BytesIO):
            status = 200
            def __init__(self, size):
                super().__init__(MP4)
                self.headers = {'Content-Length': str(size)}
        def open_response(req, timeout):
            nonlocal cdn_calls
            seen.append((req.full_url, req.get_header('Authorization')))
            if req.full_url.startswith(self.params['base_url']):
                raise urllib.error.HTTPError(req.full_url, 307, 'redirect', {'Location': 'https://cdn.example.test/original.mp4'}, None)
            cdn_calls += 1
            return Response(len(MP4) + (10 if cdn_calls == 1 else 0))
        with patch.object(client.opener, 'open', side_effect=open_response):
            result = client.download('task_original', str(self.root/'redirected.mp4'))
        self.assertEqual(Path(result).read_bytes(), MP4)
        self.assertEqual([url for url, _ in seen][::2], [self.params['base_url']+'/v1/videos/task_original/content']*2)
        self.assertEqual([auth for _, auth in seen][1::2], [None, None])
        self.assertEqual(self.state['posts'], 0)


if __name__ == '__main__':
    import unittest
    unittest.main(verbosity=2)


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromTestCase(DownloadRetryTests)
