import contextlib
import email.parser
import email.policy
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

# Exercise the exact published ZIP, isolated from all real user config/state.
import zipfile
_plugin_fixture = tempfile.TemporaryDirectory(prefix='lingxu-release-tests-')
_program = Path(_plugin_fixture.name)
_release = Path(__file__).resolve().parents[2] / 'plugin-releases/video_plugin_site_api'
with zipfile.ZipFile(_release / 'lingxu-video-1.1.4.zip') as archive:
    for name in ('main.py', 'updater.py', 'info.json'):
        (_program / name).write_bytes(archive.read('video_plugin_site_api/' + name))
spec = importlib.util.spec_from_file_location('site_plugin', _program / 'main.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
MP4 = b'\x00\x00\x00\x18ftypmp42' + b'\0' * 100


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, value):
        raw = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        state = self.server.state
        state['posts'] += 1
        state['headers'] = dict(self.headers)
        state['raw'] = self.rfile.read(int(self.headers['Content-Length']))
        if state.get('reject'):
            return self.respond(402, {'error': {'message': '账户余额不足', 'code': 'insufficient_balance'}})
        if state.get('disconnect'):
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        return self.respond(202, {'task_id': 'task_' + str(state['posts']), 'status': 'queued', 'retry_after': 0, **state.get('initial_progress', {})})

    def do_GET(self):
        s = self.server.state
        s['gets'].append(self.path)
        if self.path.endswith('/api/video/models'):
            s['public_authorization'] = self.headers.get('Authorization')
            if s.get('spec_error'):
                return self.respond(503, {'error': 'metadata unavailable'})
            return self.respond(200, s.get('public_specs', [{'id': 'vid', 'allowedSeconds': [4, 6, 8], 'rates': {'720p': 1, '1080p': 2}}]))
        if self.path.endswith('/models'):
            if s.get('catalog_error'):
                return self.respond(503, {'error': 'catalog unavailable'})
            return self.respond(200, {'data': s.get('models', [{'id': 'vid'}, {'id': 'image'}])})
        if self.path.endswith('/pricing'):
            return self.respond(200, {'data': s.get('prices', [{'model': 'vid', 'capabilities': ['video'], 'unit_price': 1}, {'model': 'image', 'capabilities': ['image']}])})
        if self.path.endswith('/content'):
            s['downloads'] = s.get('downloads', 0) + 1
            s.setdefault('download_headers', []).append(dict(self.headers))
            mode = s['download_sequence'].pop(0) if s.get('download_sequence') else ''
            if mode == 'disconnect':
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            if isinstance(mode, int):
                self.send_response(mode)
                self.send_header('Retry-After', '3')
                self.end_headers()
                return
            if s.get('bad_download'):
                raw = b'<html>server error</html>'
            else:
                raw = MP4
            self.send_response(206 if mode == 'partial_range' else 200)
            self.send_header('Content-Length', str(len(raw) + 100 if mode == 'truncated' else len(raw)))
            if mode == 'partial_range':
                self.send_header('Content-Range', f'bytes 0-{len(raw)-1}/{len(raw)+100}')
            self.end_headers()
            self.wfile.write(raw)
            return
        s['queries'] += 1
        if s.get('query_error') and s['queries'] == 1:
            return self.respond(503, {'error': 'temporary unavailable'})
        task = self.path.split('/')[-1]
        if s.get('progress_sequence'):
            return self.respond(200, {'id': task, 'retry_after': 0, **s['progress_sequence'].pop(0)})
        if s.get('failed'):
            return self.respond(200, {'id': task, 'status': 'failed', 'error_message': '参考图不符合模型要求'})
        if s.get('pending'):
            return self.respond(200, {'id': task, 'status': 'queued', 'requires_review': True, 'message': '核实原任务', 'retry_after': 0})
        return self.respond(200, {'id': task, 'model': 'vid', 'status': 'completed'})


class PluginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.state = {'posts': 0, 'gets': [], 'queries': 0}
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.state = self.state
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.params = {**p.DEFAULTS, 'base_url': f'http://127.0.0.1:{self.server.server_port}', 'api_key': 'sk-test-secret', 'model': 'vid'}
        self.context = dict(project_path=str(self.root), unique_name='scene_abc', viewer_index=2,
                            generation_round=0, output_position=[0], prompt='镜头缓慢向前', plugin_params=self.params)
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(patch.object(p, 'STATE_DIR', self.root / 'state'))
        self.stack.enter_context(patch.object(p.time, 'sleep', lambda seconds: None))

    def tearDown(self):
        self.stack.close()
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def rows(self):
        with p.database() as db:
            return [dict(r) for r in db.execute('SELECT * FROM tasks')]

    def test_round_trip_and_repeat_uses_same_result(self):
        paths = p.generate(self.context)
        self.assertEqual(Path(paths[0]).name, '0002_scene_abc_0_0.mp4')
        self.assertEqual(Path(paths[0]).read_bytes(), MP4)
        self.assertEqual(p.generate(self.context), paths)
        self.assertEqual(self.state['posts'], 1)
        self.assertEqual(json.loads(self.state['raw'])['prompt'], self.context['prompt'])
        self.assertNotIn('sk-test-secret', (p.STATE_DIR / 'tasks.sqlite3').read_bytes().decode('latin1'))

    def test_progress_roundtrip_preserves_stage_detail_and_output_without_resubmission(self):
        self.state['initial_progress'] = {'status': 'processing', 'phase': 'accepted', 'progress': 0, 'progress_known': False}
        self.state['progress_sequence'] = [
            {'status': 'queued', 'phase': 'website_queue', 'queue_position': 3, 'progress': 0, 'progress_known': False, 'progress_text': '等待网站生成名额'},
            {'status': 'queued', 'phase': 'upstream_queue', 'progress': 0, 'progress_known': False, 'progress_text': '等待生成资源'},
            {'status': 'processing', 'phase': 'generating', 'progress': 0, 'progress_known': False, 'progress_text': '正在处理参考图片'},
            {'status': 'processing', 'phase': 'generating', 'progress': 48, 'progress_known': True, 'progress_text': '视频渲染中'},
            {'status': 'processing', 'phase': 'saving', 'progress': 100, 'progress_known': False, 'progress_text': '视频已生成，网站正在保存'},
            {'status': 'completed'},
        ]
        events, ledger = [], []
        def callback(text, percent=None, tooltip=None):
            events.append((text, percent, tooltip))
            rows = self.rows()
            if rows:
                ledger.append(rows[0]['message'])
        self.context['progress_callback'] = callback
        result = p.generate(self.context)
        for stage in ('准备提交', '已受理，等待状态', '网站排队（第 3 位）', '上游排队', '生成中', '网站保存结果中', '下载中'):
            self.assertTrue(any(e[0].startswith(stage) for e in events), (stage, events))
        self.assertEqual([e[1] for e in events if e[1] is not None and e[0] == '生成中'], [48])
        self.assertTrue(any('视频渲染中' in message and '48%' in message for message in ledger))
        self.assertTrue(any('正在处理参考图片' in (e[2] or '') for e in events))
        self.assertEqual(Path(result[0]).read_bytes(), MP4)
        self.assertEqual(p.generate(self.context), result)
        self.assertEqual(self.state['posts'], 1)

    def test_legacy_queue_and_unknown_percentage_are_not_presented_as_verified_progress(self):
        self.state['progress_sequence'] = [
            {'status': 'queued', 'progress': 0},
            {'status': 'processing', 'progress': 0},
            {'status': 'processing', 'progress': 22},
            {'status': 'processing', 'progress': 0, 'progress_known': True},
            {'status': 'processing', 'progress': 90, 'progress_known': False},
        ]
        events = []
        self.context['progress_callback'] = lambda *args: events.append(args)
        p.generate(self.context)
        self.assertTrue(any(e[0].startswith('等待状态确认') for e in events))
        self.assertEqual([e[1] for e in events if e[1] is not None and e[0] == '生成中'], [22, 0])

    def test_progress_details_are_redacted_in_button_tooltip_and_persistent_record(self):
        self.state['progress_sequence'] = [{'status': 'processing', 'phase': 'generating', 'progress': 50, 'progress_known': True,
            'progress_text': '<img onerror=alert(1)> https://example.test/private?token=abc sk-test-secret',
            'message': 'sk-other-secret'}]
        events, messages = [], []
        def callback(*args):
            events.append(args)
            if self.rows(): messages.append(self.rows()[0]['message'])
        self.context['progress_callback'] = callback
        p.generate(self.context)
        text = json.dumps([events, messages])
        self.assertNotIn('sk-test-secret', text)
        self.assertNotIn('sk-other-secret', text)
        self.assertNotIn('token=abc', text)

    def test_query_errors_and_review_keep_original_id_and_continue_to_result(self):
        self.state['query_error'] = True
        self.state['progress_sequence'] = [{'status': 'queued', 'phase': 'review', 'requires_review': True,
            'progress': 70, 'message': '查询原任务回执中，请勿重复提交'}]
        events = []
        self.context['progress_callback'] = lambda *args: events.append(args)
        p.generate(self.context)
        self.assertTrue(any(e[0].startswith('查询暂时异常') for e in events))
        self.assertTrue(any(e[0].startswith('待核实，继续查询') and e[1] is None for e in events))
        self.assertEqual(self.rows()[0]['task_id'], 'task_1')
        self.assertEqual(self.state['posts'], 1)

    def test_local_media_multipart_and_slot_alignment(self):
        for name in ('ref.png', 'ref.mp4', 'ref.wav'):
            (self.root / name).write_bytes(b'media')
        self.context.update(reference_images={0: str(self.root/'ref.png')}, reference_videos={0: str(self.root/'ref.mp4')}, reference_audios={0: str(self.root/'ref.wav')}, output_position=[3, 7])
        result = p.generate(self.context)
        self.assertEqual([Path(x).name for x in result], ['0002_scene_abc_0_3.mp4', '0002_scene_abc_0_7.mp4'])
        header = self.state['headers']['Content-Type']
        msg = email.parser.BytesParser(policy=email.policy.default).parsebytes(('Content-Type: '+header+'\r\n\r\n').encode()+self.state['raw'])
        fields = [part.get_param('name', header='content-disposition') for part in msg.iter_parts()]
        self.assertTrue({'image','video','audio','model','seconds'} <= set(fields))

    def test_submission_disconnect_never_resubmits(self):
        self.state['disconnect'] = True
        with self.assertRaisesRegex(Exception, '未自动重发'):
            p.generate(self.context)
        with self.assertRaisesRegex(Exception, '阻止重复提交'):
            p.generate(self.context)
        self.assertEqual(self.state['posts'], 1)
        self.assertEqual(self.rows()[0]['state'], 'unknown')

    def test_explicit_rejection_preserves_reason(self):
        self.state['reject'] = True
        with self.assertRaisesRegex(Exception, '账户余额不足.*insufficient_balance'):
            p.generate(self.context)
        self.assertEqual(self.rows()[0]['state'], 'failed')
        with self.assertRaisesRegex(Exception, '已明确失败'):
            p.generate(self.context)
        self.assertEqual(self.state['posts'], 1)

    def test_query_503_does_not_resubmit(self):
        self.state['query_error'] = True
        p.generate(self.context)
        self.assertEqual(self.state['posts'], 1)
        self.assertEqual(self.state['queries'], 2)

    def test_failed_task_surfaces_specific_reason(self):
        self.state['failed'] = True
        with self.assertRaisesRegex(Exception, '参考图不符合模型要求'):
            p.generate(self.context)
        self.assertEqual(self.rows()[0]['state'], 'failed')

    def test_bad_download_recovery_never_generates(self):
        self.state['bad_download'] = True
        with self.assertRaisesRegex(Exception, '不是有效 MP4'):
            p.generate(self.context)
        self.assertFalse(list(self.root.glob('*.mp4')))
        self.assertFalse(list(self.root.glob('*.part')))
        self.state['bad_download'] = False
        row = self.rows()[0]
        result = p.handle_action('recover', {'params': self.params, 'local_id': row['local_id']})
        self.assertTrue(result['ok'], result)
        self.assertEqual(self.state['posts'], 1)
        self.assertTrue(Path(row['output']).exists())

    def test_catalog_no_generation_filters_video(self):
        description = '模型说明写着支持 99 秒、8K；实际参数按独立规格字段。'
        self.state['public_specs'] = [{'id': 'vid', 'description': description, 'allowedSeconds': [4, 6, 8], 'rates': {'720p': 1, '1080p': 2}}]
        result = p.handle_action('catalog', {'params': self.params})
        self.assertTrue(result['ok'], result)
        self.assertEqual([m['id'] for m in result['models']], ['vid'])
        self.assertEqual(self.state['posts'], 0)
        self.assertEqual(result['models'][0]['spec']['duration']['values'], [4, 6, 8])
        self.assertEqual(result['models'][0]['spec']['resolutions'], ['720p', '1080p'])
        self.assertEqual(result['models'][0]['description'], description)
        self.assertIsNone(self.state['public_authorization'])

    def test_removed_or_unpriced_model_blocks_before_post_without_ledger(self):
        self.state['models'] = [{'id': 'new-video'}]
        with self.assertRaisesRegex(Exception, '重新选择模型'):
            p.generate(self.context)
        self.state['models'] = [{'id': 'vid'}]
        self.state['prices'] = []
        with self.assertRaisesRegex(Exception, '重新选择模型'):
            p.generate(self.context)
        self.assertEqual(self.state['posts'], 0)
        self.assertEqual(self.rows(), [])

    def test_new_model_appears_and_can_generate_without_plugin_update(self):
        self.state['models'] = [{'id': 'new-video'}]
        self.state['prices'] = [{'model': 'new-video', 'capabilities': ['video'], 'unit_price': 2}]
        self.state['public_specs'] = [{'id': 'new-video', 'allowedSeconds': [6], 'rates': {'720p': 2}}]
        result = p.handle_action('catalog', {'params': self.params})
        self.assertEqual(result['models'][0]['id'], 'new-video')
        self.params['model'] = 'new-video'
        self.assertEqual(len(p.generate(self.context)), 1)
        self.assertEqual(self.state['posts'], 1)

    def test_sync_failure_blocks_new_task_without_claiming_model_removed(self):
        for value in (True, False):
            self.state['catalog_error'] = value
            self.state['models'] = None if not value else []
            with self.assertRaisesRegex(Exception, '无法确认网站最新模型'):
                p.generate(self.context)
        self.assertEqual(self.state['posts'], 0)
        self.assertEqual(self.rows(), [])

    def test_latest_spec_overrides_stale_saved_spec_before_submission(self):
        self.params['_model_spec'] = p.handle_action('catalog', {'params': self.params})['models'][0]['spec']
        self.state['public_specs'] = [{'id': 'vid', 'allowedSeconds': [10], 'rates': {'720p': 1}}]
        with self.assertRaisesRegex(Exception, '时长'):
            p.generate(self.context)
        self.assertEqual(self.state['posts'], 0)
        self.params['seconds'] = '10'
        self.assertEqual(len(p.generate(self.context)), 1)

    def test_explicit_disabled_model_blocks_but_health_heuristic_does_not(self):
        self.state['public_specs'] = [{'id': 'vid', 'available': False}]
        with self.assertRaisesRegex(Exception, '重新选择模型'):
            p.generate(self.context)
        self.assertEqual(self.state['posts'], 0)
        self.state['public_specs'] = [{'id': 'vid', 'available': True, 'modelStatus': {'state': 'unavailable'}}]
        self.assertEqual(len(p.generate(self.context)), 1)

    def test_existing_task_can_recover_after_model_removed_and_catalog_fails(self):
        self.state['bad_download'] = True
        with self.assertRaises(Exception):
            p.generate(self.context)
        self.state['bad_download'] = False
        self.state['models'] = []
        self.state['catalog_error'] = True
        paths = p.generate(self.context)
        self.assertEqual(Path(paths[0]).read_bytes(), MP4)
        self.assertEqual(self.state['posts'], 1)

    def test_descriptions_use_exact_canonical_model_and_work_without_specs(self):
        self.state['models'] = [{'id': 'public-alias', 'canonical_id': 'vid'}]
        self.state['public_specs'] = [{'id': 'vid', 'description': '  模型介绍原文  '}, {'id': 'other', 'description': '其他模型的描述'}]
        row = p.handle_action('catalog', {'params': self.params})['models'][0]
        self.assertEqual(row['description'], '模型介绍原文')
        self.assertIsNone(row['spec'])
        self.state['public_specs'][0]['description'] = {'unsupported': 'value'}
        self.assertEqual(p.handle_action('catalog', {'params': self.params})['models'][0]['description'], '')
        self.state['public_specs'] = []
        self.assertEqual(p.handle_action('catalog', {'params': self.params})['models'][0]['description'], '')
        self.assertEqual(self.state['posts'], 0)

    def test_specs_unavailable_preserves_catalog_and_manual_entry(self):
        self.state['spec_error'] = True
        result = p.handle_action('catalog', {'params': self.params})
        self.assertTrue(result['ok'])
        self.assertIsNone(result['models'][0]['spec'])
        self.assertIn('手动', result['spec_warning'])
        self.assertEqual(result['models'][0]['price']['unit_price'], 1)

    def test_model_spec_rejects_invalid_before_submission(self):
        selected = p.handle_action('catalog', {'params': self.params})['models'][0]['spec']
        self.params['_model_spec'] = selected
        self.params['seconds'] = '5'
        with self.assertRaisesRegex(Exception, '时长.*未创建'):
            p.generate(self.context)
        self.params['seconds'] = '6'
        self.params['resolution'] = '768p'
        with self.assertRaisesRegex(Exception, '分辨率.*未创建'):
            p.generate(self.context)
        self.assertEqual(self.state['posts'], 0)
        self.assertEqual(self.rows(), [])
        self.params['resolution'] = '1080p'
        self.assertEqual(len(p.generate(self.context)), 1)

    def test_spec_rules_and_existing_task_recovery(self):
        self.state['public_specs'] = [{'id': 'vid', 'routingLimits': {'duration': {'mode': 'range', 'min': 2, 'max': 10, 'step': 2}, 'resolutions': ['720p']}, 'allowedSeconds': [3], 'rates': {'1080p': 999}}]
        selected = p.handle_action('catalog', {'params': self.params})['models'][0]['spec']
        self.assertEqual(selected['resolutions'], ['720p'])
        self.params['_model_spec'] = selected
        self.params['seconds'] = '3'
        with self.assertRaisesRegex(Exception, '时长'):
            p.generate(self.context)
        self.params['seconds'] = '6'
        paths = p.generate(self.context)
        self.params['_model_spec']['duration'] = {'mode': 'options', 'values': [10]}
        self.assertEqual(p.generate(self.context), paths)
        self.assertEqual(self.state['posts'], 1)
        fixed = p.video_spec({'routingLimits': {'duration': {'mode': 'fixed', 'min': 8}}})
        self.assertEqual(fixed['duration'], {'mode': 'options', 'values': [8]})

    def test_frame_and_mixed_source_guard(self):
        self.context['end_frame_path'] = 'tail.png'
        with self.assertRaisesRegex(Exception, '首尾帧'):
            p.generate(self.context)
        del self.context['end_frame_path']
        ref = self.root/'ref.png'
        ref.write_bytes(b'image')
        self.context['reference_images'] = {0: str(ref), 1: 'https://example.test/ref.png'}
        with self.assertRaisesRegex(Exception, '重排参考编号'):
            p.generate(self.context)
        self.assertEqual(self.state['posts'], 0)

    def test_bind_unknown_and_scope_isolation(self):
        self.state['disconnect'] = True
        with self.assertRaises(Exception):
            p.generate(self.context)
        row = self.rows()[0]
        denied = p.handle_action('recover', {'params': {**self.params, 'api_key': 'another-key'}, 'local_id': row['local_id']})
        self.assertFalse(denied['ok'])
        result = p.handle_action('bind', {'params': self.params, 'local_id': row['local_id'], 'task_id': 'task_1'})
        self.assertTrue(result['ok'], result)
        self.state['disconnect'] = False
        p.generate(self.context)
        self.assertEqual(self.state['posts'], 1)

    def test_concurrent_same_slot_is_locked(self):
        slot = str(self.root / '0002_scene_abc_0_0.mp4')
        with p.task_lock(slot):
            with self.assertRaisesRegex(Exception, '正在执行'):
                p.generate(self.context)
        self.assertEqual(self.state['posts'], 0)

    def test_pending_deadline_keeps_id(self):
        self.state['pending'] = True
        with patch.object(p.time, 'monotonic', side_effect=[0, 1, 2, 3000]):
            with self.assertRaisesRegex(Exception, '等待达到上限'):
                p.generate(self.context)
        self.assertEqual(self.rows()[0]['task_id'], 'task_1')
        self.assertEqual(self.rows()[0]['state'], 'pending')
        self.assertEqual(self.state['posts'], 1)

    def test_changed_snapshot_does_not_overwrite_original_task(self):
        p.generate(self.context)
        self.context['prompt'] = 'different prompt'
        with self.assertRaisesRegex(Exception, '另一组参数'):
            p.generate(self.context)
        self.assertEqual(self.state['posts'], 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
