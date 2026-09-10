import base64, concurrent.futures, json, os, subprocess, sys, tempfile, unittest
from pathlib import Path
SCRIPT = Path(__file__).parents[1] / "plugin/scripts/artifact_store.py"
def run(home, request):
    encoded = base64.b64encode(json.dumps(request).encode()).decode(); result = subprocess.run([sys.executable, str(SCRIPT), encoded], cwd=home, text=True, capture_output=True, check=True)
    return json.loads(base64.b64decode(result.stdout.strip().split("\t", 1)[1]))
class StoreTests(unittest.TestCase):
  def test_probe_does_not_create_store(self):
    with tempfile.TemporaryDirectory() as temp:
      self.assertTrue(run(temp, {"action":"probe"})["ok"]); self.assertFalse((Path(temp)/".openhands").exists())
  def test_snapshot_list_get_verify_and_reference(self):
    with tempfile.TemporaryDirectory() as temp:
      source = Path(temp)/"notes.md"; source.write_text("# hello")
      request = {"action":"register","id":"ah-abcdefgh","title":"Notes","summary":"A durable note","type":"handoff","tags":["test"],"originating_skill":"handoff","storage_mode":"snapshot","source":str(source),"media_type":"text/markdown"}
      registered = run(temp, request); self.assertTrue(registered["ok"]); self.assertEqual(run(temp,{"action":"list"})["data"]["artifacts"][0]["id"], "ah-abcdefgh")
      self.assertEqual(run(temp,{"action":"get","id":"ah-abcdefgh","preview":True})["data"]["preview"], "# hello"); self.assertEqual(run(temp,{"action":"verify","id":"ah-abcdefgh"})["data"]["status"], "valid")
      ref = run(temp,{"action":"register","id":"ah-ijklmnop","title":"Reference","summary":"A ref","type":"report","originating_skill":"save-artifact","storage_mode":"reference","source":str(source)}); self.assertTrue(ref["ok"])
  def test_rejects_traversal_and_symlink(self):
    with tempfile.TemporaryDirectory() as temp:
      outside = Path(temp)/"outside"; outside.write_text("x"); linked = Path(temp)/"linked"; linked.symlink_to(outside)
      request={"action":"register","title":"Bad","summary":"Bad source","type":"other","originating_skill":"save-artifact","storage_mode":"snapshot","source":str(linked)}
      self.assertFalse(run(temp,request)["ok"]); self.assertFalse(run(temp,{"action":"get","id":"../bad"})["ok"])
  def test_concurrent_atomic_registration(self):
    with tempfile.TemporaryDirectory() as temp:
      source = Path(temp)/"source.txt"; source.write_text("atomic")
      def register(number): return run(temp,{"action":"register","id":f"ah-concurrent-{number:02d}","title":f"Artifact {number}","summary":"Concurrent registration","type":"report","originating_skill":"save-artifact","storage_mode":"snapshot","source":str(source)})
      with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor: results=list(executor.map(register, range(12)))
      self.assertTrue(all(result["ok"] for result in results)); listed=run(temp,{"action":"list"})["data"]["artifacts"]
      self.assertEqual(len(listed),12); self.assertFalse(any(item.startswith(".pending-") for item in os.listdir(Path(temp)/".openhands/apps/artifact-handoff/artifacts")))
  def test_plugin_resources_are_present(self):
    root=SCRIPT.parents[1]
    self.assertEqual(json.loads((root/".plugin/plugin.json").read_text())["name"],"artifact-handoff")
    for skill in ("handoff","prototype","save-artifact"): self.assertIn("name:", (root/"skills"/skill/"SKILL.md").read_text())
if __name__ == "__main__": unittest.main()
