from pathlib import Path
from unittest.mock import patch
from test_download_retry import DownloadRetryTests, p, MP4

class ResumeTests(DownloadRetryTests):
    def enable_resume(self):
        self.state['resume_bytes'] = MP4 + bytes(range(256)) * 8

    def test_interruption_resumes_range_and_returns_complete_original_slot(self):
        self.enable_resume()
        self.state['download_sequence'] = ['break', 'break', 'ok']
        events=[]
        self.context['progress_callback']=lambda *args: events.append(args)
        result=p.generate(self.context)
        self.assertEqual(Path(result[0]).read_bytes(), self.state['resume_bytes'])
        headers=self.state['download_headers']
        self.assertIsNone(headers[0].get('Range'))
        self.assertEqual([h.get('Range') for h in headers[1:]], ['bytes=16-', 'bytes=32-'])
        self.assertTrue(all(h.get('If-Range','').startswith('"sha256-') for h in headers[1:]))
        self.assertTrue(any(e[0]=='断点续传' for e in events))
        self.assert_one_original_task()
        self.assertFalse(list(self.root.glob('*.part.json')))

    def test_exhausted_download_resumes_from_saved_bytes_in_new_client(self):
        self.enable_resume()
        self.state['download_sequence']=['break']*4
        with self.assertRaisesRegex(Exception, '已尝试 4 次'): p.generate(self.context)
        checkpoint=list(self.root.glob('*.part'))
        self.assertEqual(len(checkpoint),1)
        self.assertEqual(checkpoint[0].stat().st_size,64)
        row=self.rows()[0]
        result=p.handle_action('recover',{'params':self.params,'local_id':row['local_id']})
        self.assertTrue(result['ok'],result)
        self.assertEqual(self.state['download_headers'][-1].get('Range'),'bytes=64-')
        self.assertEqual(Path(row['output']).read_bytes(),self.state['resume_bytes'])
        self.assert_one_original_task()

    def test_changed_file_or_ignored_range_restarts_without_appending(self):
        for changed in (False,True):
            with self.subTest(changed=changed):
                self.context['generation_round']+=1
                self.enable_resume()
                self.state['download_sequence']=['break']*4
                with self.assertRaises(Exception):p.generate(self.context)
                row=self.rows()[-1]
                if changed:self.state['resume_bytes']=MP4+b'new-video'*300
                else:self.state['ignore_range']=True
                result=p.handle_action('recover',{'params':self.params,'local_id':row['local_id']})
                self.assertTrue(result['ok'],result)
                self.assertEqual(Path(row['output']).read_bytes(),self.state['resume_bytes'])
                self.state['ignore_range']=False
        self.assertEqual(self.state['posts'],2)

    def test_weak_validator_falls_back_to_full_download(self):
        self.enable_resume();self.state['weak_etag']=True
        self.state['download_sequence']=['break','ok']
        result=p.generate(self.context)
        self.assertTrue(all('Range' not in h for h in self.state['download_headers']))
        self.assertEqual(Path(result[0]).read_bytes(),self.state['resume_bytes'])
        self.assert_one_original_task()

    def test_invalid_range_and_416_restart_safely(self):
        for mode in ('bad_range','range416'):
            with self.subTest(mode=mode):
                self.context['generation_round']+=1
                self.enable_resume();self.state['download_sequence']=['break',mode,'ok']
                result=p.generate(self.context)
                self.assertIsNone(self.state['download_headers'][-1].get('Range'))
                self.assertEqual(Path(result[0]).read_bytes(),self.state['resume_bytes'])
        self.assertEqual(self.state['posts'],2)

    def test_corrupt_local_checkpoint_is_not_reused(self):
        self.enable_resume();self.state['download_sequence']=['break']*4
        with self.assertRaises(Exception):p.generate(self.context)
        part=next(self.root.glob('*.part'));part.write_bytes(b'corrupt'+part.read_bytes()[7:])
        result=p.generate(self.context)
        self.assertIsNone(self.state['download_headers'][-1].get('Range'))
        self.assertEqual(Path(result[0]).read_bytes(),self.state['resume_bytes'])
        self.assert_one_original_task()

    def test_crash_tail_is_truncated_to_verified_checkpoint(self):
        self.enable_resume();self.state['download_sequence']=['break']*4
        with self.assertRaises(Exception):p.generate(self.context)
        part=next(self.root.glob('*.part'))
        with part.open('ab') as file:file.write(b'uncommitted-tail')
        result=p.generate(self.context)
        self.assertEqual(self.state['download_headers'][-1].get('Range'),'bytes=64-')
        self.assertEqual(Path(result[0]).read_bytes(),self.state['resume_bytes'])
        self.assert_one_original_task()

    def test_other_account_cannot_reuse_saved_checkpoint(self):
        self.enable_resume();self.state['download_sequence']=['break']*4
        with self.assertRaises(Exception):p.generate(self.context)
        row=self.rows()[0]
        other=p.Client({**self.params,'api_key':'different-fixture-account'})
        other.download(row['task_id'],row['output'])
        self.assertIsNone(self.state['download_headers'][-1].get('Range'))
        self.assertEqual(Path(row['output']).read_bytes(),self.state['resume_bytes'])
        self.assertEqual(self.state['posts'],1)

def load_tests(loader, tests, pattern):
    return loader.loadTestsFromTestCase(ResumeTests)
