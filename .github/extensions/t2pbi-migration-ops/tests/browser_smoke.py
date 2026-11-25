"""End-to-end canvas form regression using isolated synthetic state and installed Edge."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from playwright.sync_api import sync_playwright


class CanvasBrowserTests(unittest.TestCase):
    """Exercise real browser forms, downloads, histories and refresh persistence."""

    def test_offline_planning_canvas(self):
        with tempfile.TemporaryDirectory(prefix="_canvas-offline-", dir=Path.cwd()) as root:
            process = subprocess.Popen(
                ["node", str(Path(__file__).with_name("ui-fixture.mjs")), root,
                 "--planning-scale", "--offline-hostile"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                context = json.loads(process.stdout.readline())
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(channel="msedge", headless=True,
                                                         downloads_path=root)
                    try:
                        page = browser.new_page(viewport={"width": 1440, "height": 1100})
                        failures = []
                        page.on("pageerror", lambda error: failures.append(str(error)))
                        page.goto(context["url"])
                        page.locator("#run-select").select_option(context["run"])
                        page.get_by_role("button", name="Refresh evidence", exact=True).click()
                        page.get_by_role("button", name="Planning summary", exact=True).click()
                        page.wait_for_function(
                            "() => document.querySelector('#planning-workbook-count').textContent === '101'")
                        parity = page.locator("#assessment-planning").evaluate("""e => ({
                            kpis: e.querySelector('.assessment-kpis').textContent,
                            recommendations: e.querySelector('#planning-overview-recommendations').innerHTML,
                            usage: e.querySelector('#planning-overview-usage').innerHTML,
                            score: e.querySelector('#planning-headlines [data-metric="score"]').textContent,
                            cardColor: getComputedStyle(e.querySelector('.metrics article')).backgroundColor,
                            headingSize: getComputedStyle(e.querySelector('h2')).fontSize
                        })""")
                        # Export remains the whole saved assessment, even with active app filters.
                        page.locator("#planning-detail > summary").click()
                        page.locator("#planning-filter-menu > summary").click()
                        page.locator("#planning-attribute-search").fill("Search filtered workbooks")
                        page.locator("#planning-search").fill("no matching workbook")
                        self.assertEqual(page.locator("#planning-workbooks tr").count(), 0)
                        with page.expect_download() as downloaded:
                            page.locator("#planning-export-html").click()
                        artifact = Path(root) / downloaded.value.suggested_filename
                        downloaded.value.save_as(artifact)
                        report = artifact.read_text(encoding="utf-8")
                        self.assertNotIn(context["run"], report)
                        for private in ["never-export-this", "127.0.0.1:1234", "Private diagnostic",
                                        "C:\\private", "__CANVAS_TOKEN__", "/home/alice", "offline-secret"]:
                            self.assertNotIn(private, report)
                        # A distinct offline browser context has no cookies, API or server access.
                        offline = browser.new_context(offline=True, viewport={"width": 1210, "height": 1100})
                        exported = offline.new_page()
                        requests = []
                        violations = []
                        exported.on("pageerror", lambda error: failures.append(str(error)))
                        exported.on("request", lambda request: requests.append(request.url)
                                    if not request.url.startswith(("file:", "blob:")) else None)
                        exported.on("console", lambda message: violations.append(message.text)
                                    if "Content Security Policy" in message.text else None)
                        offline.route("**/*", lambda route: route.continue_()
                                      if route.request.url.startswith("file:") else route.abort())
                        exported.goto(artifact.as_uri())
                        exported.wait_for_function("() => document.documentElement.dataset.offlineReady === 'true'")
                        actual = exported.locator("#assessment-planning").evaluate("""e => ({
                            kpis: e.querySelector('.assessment-kpis').textContent,
                            recommendations: e.querySelector('#planning-overview-recommendations').innerHTML,
                            usage: e.querySelector('#planning-overview-usage').innerHTML,
                            score: e.querySelector('#planning-headlines [data-metric="score"]').textContent,
                            cardColor: getComputedStyle(e.querySelector('.metrics article')).backgroundColor,
                            headingSize: getComputedStyle(e.querySelector('h2')).fontSize
                        })""")
                        self.assertEqual(actual, parity)
                        self.assertEqual(exported.locator("#planning-search").input_value(), "")
                        self.assertIn("entire assessment", exported.locator("#planning-source").inner_text())
                        self.assertIn("2026", exported.locator("#planning-status").inner_text())
                        self.assertEqual(exported.locator("#planning-workbooks tr").count(), 50)
                        self.assertEqual(exported.locator(".planning-section[open]").count(), 0)
                        self.assertEqual(exported.locator(
                            "#planning-use-selection, #planning-export, #planning-export-html, "
                            "[data-assessment-page], form, script[src], link, img").count(), 0)
                        self.assertIsNone(exported.evaluate("() => globalThis.injected"))
                        slider = exported.locator("#planning-usage-top")
                        slider.focus()
                        slider.press("End")
                        self.assertIn("100.0%", exported.locator("#planning-overview-usage").inner_text())
                        self.assertEqual(exported.locator("#planning-overview-usage svg > rect").count(), 101)
                        slider.press("Home")
                        self.assertIn("Top 1 account for 1.0%", exported.locator("#planning-overview-usage").inner_text())
                        exported.locator("#planning-detail > summary").click()
                        with exported.expect_download() as complete:
                            exported.locator("#planning-filtered-export").click()
                        all_csv = Path(root) / "offline-all.csv"
                        complete.value.save_as(all_csv)
                        complete_text = all_csv.read_text(encoding="utf-8-sig")
                        self.assertIn('"view-orphan"', complete_text)
                        self.assertNotIn("/home/alice", complete_text)
                        self.assertNotIn("offline-secret", complete_text)
                        exported.locator("#planning-next").click()
                        self.assertIn("51-100 of 101", exported.locator("#planning-page-label").inner_text())
                        exported.locator("#planning-next").click()
                        self.assertEqual(exported.locator("#planning-workbooks tr").count(), 1)
                        exported.locator("#planning-filter-menu > summary").click()
                        exported.locator("#planning-attribute-search").fill("Sort workbooks")
                        exported.locator("#planning-sort").select_option("name:asc")
                        self.assertIn("</script><!--<img", exported.locator("#planning-workbooks tr").first.inner_text())
                        self.assertIsNone(exported.evaluate("() => globalThis.injected"))
                        exported.locator("#planning-attribute-search").fill("understated")
                        exported.locator("#planning-attr-understated-mode").select_option("yes")
                        self.assertEqual(exported.locator("#planning-workbooks tr").count(), 1)
                        self.assertEqual(exported.locator("#planning-views tr").count(), 1)
                        with exported.expect_download() as filtered:
                            exported.locator("#planning-filtered-export").click()
                        local_csv = Path(root) / "offline-filtered.csv"
                        filtered.value.save_as(local_csv)
                        csv_text = local_csv.read_text(encoding="utf-8-sig")
                        self.assertIn('"source-001"', csv_text)
                        self.assertIn('"view-001"', csv_text)
                        self.assertNotIn('"view-orphan"', csv_text)
                        self.assertNotIn('"large-source-1"', csv_text)
                        self.assertNotIn(context["run"], csv_text)
                        self.assertIn("NOT_CHECKED", csv_text)
                        exported.locator("#planning-chart-reset").click()
                        exported.locator("#planning-date-from").focus()
                        exported.locator("#planning-date-from").press("ArrowRight")
                        self.assertEqual(exported.locator("#planning-after").input_value(), "2025-12-31")
                        self.assertEqual(exported.locator("#planning-workbooks tr").count(), 1)
                        exported.locator("#planning-chart-reset").click()
                        exported.locator("#planning-chart-complexity").get_by_role(
                            "button", name="Score 1-39:", exact=False).click()
                        self.assertEqual(exported.locator("#planning-workbooks tr").count(), 1)
                        self.assertEqual(exported.locator("#planning-band").input_value(), "lower")
                        exported.locator("#planning-chart-reset").click()
                        exported.get_by_role("link", name="By project", exact=True).click()
                        self.assertIsNotNone(exported.locator("#planning-project-section").get_attribute("open"))
                        exported.locator("#planning-projects tr").filter(
                            has_text="Large synthetic project").get_by_role("button").click()
                        self.assertIn("of 100", exported.locator("#planning-page-label").inner_text())
                        exported.locator("#planning-reset").click()
                        exported.get_by_role("link", name="By datasource", exact=True).click()
                        exported.locator("#planning-datasources button").click()
                        self.assertEqual(exported.locator("#planning-workbooks tr").count(), 1)
                        exported.locator("#planning-reset").click()
                        exported.locator(".planning-section").filter(
                            has=exported.get_by_role("heading", name="Tableau views by lifetime usage", exact=True)
                        ).locator(":scope > summary").click()
                        exported.locator("#planning-view-sort").select_option("name:asc")
                        exported.locator("#planning-view-search").fill("omitted")
                        self.assertEqual(exported.locator("#planning-views tr").count(), 1)
                        exported.locator(".planning-section").filter(
                            has=exported.get_by_role("heading", name="Published datasource inventory", exact=True)
                        ).locator(":scope > summary").click()
                        exported.locator("#planning-catalog-sort").select_option("name:asc")
                        exported.locator("#planning-catalog-search").fill("without observed")
                        self.assertEqual(exported.locator("#planning-catalog tr").count(), 1)
                        exported.set_viewport_size({"width": 390, "height": 844})
                        self.assertTrue(exported.locator(".assessment-overview").evaluate(
                            "(e) => e.getBoundingClientRect().right <= window.innerWidth"))
                        self.assertEqual(requests, [])
                        self.assertEqual(violations, [])
                        self.assertEqual(failures, [])
                        offline.close()
                    finally:
                        browser.close()
            finally:
                process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0)

    def test_api_assessment_scoped_wave_and_html_report(self):
        with tempfile.TemporaryDirectory(prefix="_canvas-workflow-", dir=Path.cwd()) as root:
            process = subprocess.Popen(
                ["node", str(Path(__file__).with_name("ui-fixture.mjs")), root, "--no-runs"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                context = json.loads(process.stdout.readline())
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(channel="msedge", headless=True)
                    try:
                        page = browser.new_page(viewport={"width": 1440, "height": 1100})
                        failures = []
                        page.on("pageerror", lambda error: failures.append(str(error)))
                        page.goto(context["url"])
                        page.get_by_role("button", name="Planning summary", exact=True).click()
                        self.assertTrue(page.locator("#planning-export-html").is_disabled())
                        page.get_by_role("button", name="Batch creation", exact=True).click()
                        page.locator("#assessment-form [name=label]").fill("API-only environment")
                        page.get_by_role("button", name="Approve & queue API assessment").click()
                        page.get_by_text("API assessment queued before run allocation;", exact=False).wait_for()
                        self.assertIn("api assessment", page.locator("#batch-info").inner_text())
                        self.assertIn("No workbook/datasource downloads", page.locator("#handoff").input_value())
                        page.locator("#update-form [name=sessionId]").fill("synthetic-assessment-session")
                        page.locator("#update-form [name=note]").fill("Claim API metadata assessment")
                        page.get_by_role("button", name="Record transition").click()
                        page.get_by_text("Progress recorded", exact=False).wait_for()
                        page.locator("#attach-form [name=run]").fill(context["run"])
                        page.get_by_role("button", name="Link allocated run", exact=True).click()
                        page.get_by_text("Allocated run linked.", exact=False).wait_for()
                        page.locator("#run-select").select_option(context["run"])
                        page.get_by_role("button", name="Assessment", exact=True).click()
                        page.get_by_role("button", name="Planning summary", exact=True).click()
                        self.assertTrue(page.locator("#planning-export-html").is_enabled())
                        csv_box = page.locator("#planning-export").bounding_box()
                        html_box = page.locator("#planning-export-html").bounding_box()
                        self.assertGreater(html_box["y"], csv_box["y"])
                        with page.expect_download() as downloaded:
                            page.locator("#planning-export-html").click()
                        report = Path(downloaded.value.path()).read_text(encoding="utf-8")
                        self.assertIn("\\u003cSynthetic \\u0026 safe\\u003e", report)
                        self.assertIn("NOT_CHECKED", report)
                        self.assertIn("Workbooks in planning drill-down", report)
                        self.assertNotIn(context["run"], report)
                        page.get_by_role("button", name="Batch creation", exact=True).click()
                        page.get_by_role("checkbox", name="Select workbook <Synthetic & safe>").check()
                        page.locator("#batch-form [name=label]").fill("Investigate exact wave")
                        page.locator("#batch-form [name=numeric]").select_option("required")
                        page.get_by_role("button", name="Approve & queue batch").click()
                        page.get_by_text("1 stage track(s) queued", exact=False).wait_for()
                        self.assertIn("artifact investigation", page.locator("#batch-info").inner_text())
                        self.assertIn("Only scoped download/parse investigation", page.locator("#handoff").input_value())
                        page.get_by_role("button", name="Batch creation", exact=True).click()
                        page.locator("#batch-form [name=stage]").select_option("wave_conversion")
                        page.locator("#batch-form [name=batchSize]").fill("1")
                        page.get_by_role("button", name="Approve & queue batch").click()
                        page.get_by_text("1 stage track(s) queued", exact=False).wait_for()
                        self.assertIn("Parent assessment:", page.locator("#batch-info").inner_text())
                        self.assertIn("No run allocated yet", page.locator("#batch-info").inner_text())
                        self.assertIn("repeats survey/assessment/downloads", page.locator("#handoff").input_value())
                        page.reload()
                        page.get_by_role("button", name="Batch tracks", exact=False).click()
                        self.assertIn("wave_conversion", page.locator("#batch-list").inner_text())
                        self.assertEqual(failures, [])
                    finally:
                        browser.close()
            finally:
                process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0)

    def test_forms_history_and_csv(self):
        with tempfile.TemporaryDirectory(prefix="_canvas-browser-", dir=Path.cwd()) as root:
            fixture = Path(__file__).with_name("ui-fixture.mjs")
            process = subprocess.Popen(
                ["node", str(fixture), root, "--no-runs", "--planning-scale"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                context = json.loads(process.stdout.readline())
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(channel="msedge", headless=True)
                    try:
                        page = browser.new_page(viewport={"width": 1440, "height": 1100})
                        page.clock.install()
                        failures = []
                        activity_requests = []
                        page.on("request", lambda request: activity_requests.append(request.url)
                                if request.url.endswith("/api/get_agent_activity") else None)
                        page.on("pageerror", lambda error: failures.append(str(error)))
                        page.goto(context["url"])
                        self.assertEqual(page.locator("nav .nav").all_text_contents()[0].strip(), "01 Assessment")
                        self.assertTrue(page.locator("#assessment").is_visible())
                        self.assertTrue(page.locator("#overview").is_hidden())
                        self.assertEqual(page.locator('nav [aria-current="page"]').get_attribute("data-tab"), "assessment")
                        self.assertEqual(page.locator("#run-select").input_value(), "")
                        self.assertEqual(page.locator("#run-select option").count(), 1)
                        self.assertEqual(page.locator("#planning-lifetime-count").inner_text(), "Unknown")
                        self.assertEqual(page.locator("#planning-published-count").inner_text(), "Unknown")
                        self.assertTrue(page.locator("#planning-usage-top").is_disabled())
                        self.assertEqual(page.locator(".assessment-overview svg").count(), 0)
                        self.assertTrue(page.locator("#planning-usage-top").is_disabled())
                        page.evaluate("""async () => {
                            const {renderPlanningOverview} = await import('/planning-overview.mjs');
                            renderPlanningOverview({available:true, workbooks:[], complexity:[],
                                datasourceInventory:[], datasourceStatus:'available', status:'inventory_observed',
                                totals:{tiers:{}, unknownScores:0, unresolvedEdges:0}},
                                (tag,text,cls) => {const e=document.createElement(tag);
                                    if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;});
                        }""")
                        self.assertEqual(page.locator("#planning-published-count").inner_text(), "0")
                        self.assertEqual(page.locator("#planning-lifetime-count").inner_text(), "Unknown")
                        self.assertEqual(page.locator(".assessment-overview svg").count(), 0)
                        edge_cases = page.evaluate("""async () => {
                            const {renderPlanningOverview} = await import('/planning-overview.mjs');
                            const node=(tag,text,cls)=>{const e=document.createElement(tag);
                                if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
                            return [[0,0],[20],[20,null,0],Array(1000).fill(20)].map(values=>{
                                renderPlanningOverview({available:true,
                                    workbooks:values.map((v,i)=>({name:`Workbook ${i}`, signals:{viewsLifetime:v}})),
                                    complexity:[], datasourceInventory:[], datasourceStatus:'available',
                                    status:'inventory_observed',totals:{tiers:{},unknownScores:0,unresolvedEdges:0}},
                                    node,1000);
                                const slider=document.getElementById('planning-usage-top');
                                return {max:slider.max,value:slider.value,disabled:slider.disabled,
                                    bars:document.querySelectorAll('#planning-overview-usage svg > rect').length,
                                    markers:document.querySelectorAll('.usage-coverage-marker').length,
                                    text:document.getElementById('planning-overview-usage').textContent};
                            });
                        }""")
                        self.assertTrue(edge_cases[0]["disabled"])
                        self.assertEqual(edge_cases[0]["markers"], 0)
                        self.assertIn("total zero", edge_cases[0]["text"])
                        self.assertTrue(edge_cases[1]["disabled"])
                        self.assertEqual(edge_cases[1]["value"], "1")
                        self.assertEqual(edge_cases[2]["max"], "2")
                        self.assertEqual(edge_cases[2]["bars"], 2)
                        self.assertIn("2 known / 1 unknown", edge_cases[2]["text"])
                        self.assertEqual(edge_cases[3]["bars"], 1000)
                        self.assertIn("Top 1000 account for 100.0%", edge_cases[3]["text"])
                        page.get_by_role("button", name="Planning summary", exact=True).click()
                        self.assertTrue(page.locator("#planning-date-from").is_disabled())
                        self.assertTrue(page.locator("#planning-date-through").is_disabled())
                        self.assertIn("No assessable workbook evidence", page.locator("#planning-chart-status").inner_text())
                        page.get_by_role("button", name="Batch creation", exact=True).click()
                        self.assertTrue(page.locator("#batch-form button").is_disabled())
                        self.assertTrue(page.locator("#source-form button").is_enabled())
                        page.locator("#source-form [name=label]").fill("One-off browser wave")
                        page.locator("#source-form [name=value]").fill("https://tableau.example.test/views/OneOff/Dashboard")
                        page.locator("#source-form [name=numeric]").select_option("required")
                        page.get_by_role("button", name="Approve & queue one-off").click()
                        page.get_by_text("One-off batch queued without assessment.", exact=False).wait_for()
                        self.assertIn("No run allocated yet", page.locator("#batch-info").inner_text())
                        self.assertIn("attach_batch_run", page.locator("#handoff").input_value())
                        with page.expect_download() as source_download:
                            page.get_by_role("button", name="Export progress CSV").click()
                        source_csv = Path(source_download.value.path()).read_text(encoding="utf-8-sig")
                        self.assertIn('"source_request"', source_csv)
                        self.assertIn("https://tableau.example.test/views/OneOff/Dashboard", source_csv)
                        page.locator("#update-form [name=sessionId]").fill("synthetic-one-off-session")
                        page.locator("#update-form [name=note]").fill("Claiming one-off route")
                        page.get_by_role("button", name="Record transition").click()
                        page.get_by_text("Progress recorded.", exact=False).wait_for()
                        page.locator("#attach-form [name=run]").fill(context["run"])
                        page.get_by_role("button", name="Link allocated run", exact=True).click()
                        page.get_by_text("Allocated run linked.", exact=False).wait_for()
                        page.locator("#update-form [name=status]").select_option("finished")
                        page.locator("#update-form [name=evidence]").fill("one-off-browser-signoff.json")
                        page.locator("#update-form [name=note]").fill("One-off stage finished")
                        page.get_by_role("button", name="Record transition").click()
                        page.get_by_text("one-off-browser-signoff.json", exact=False).wait_for()
                        page.locator("nav [data-tab=assessment]").click()
                        page.locator("#run-select").select_option(context["run"])
                        page.get_by_role("button", name="Agent activity", exact=True).click()
                        page.locator("#agent-sessions").get_by_text("<Synthetic builder>", exact=True).wait_for()
                        self.assertIn("running (recorded)", page.locator("#agent-sessions").inner_text())
                        self.assertIn("idle (recorded)", page.locator("#agent-sessions").inner_text())
                        self.assertIn("Stale (>2 minutes)", page.locator("#agent-sessions").inner_text())
                        self.assertIn("tool-call linked", page.locator("#agent-sessions").inner_text())
                        observed_requests = len(activity_requests)
                        page.clock.fast_forward(31000)
                        page.wait_for_function(
                            "() => document.querySelector('#agents-status').textContent.startsWith('Observed')")
                        self.assertEqual(len(activity_requests), observed_requests + 1)
                        page.locator("#agents-auto").uncheck()
                        page.clock.fast_forward(31000)
                        self.assertEqual(len(activity_requests), observed_requests + 1)
                        page.get_by_role("button", name="Refresh agent activity", exact=True).click()
                        page.wait_for_function("() => document.querySelector('#agents-status').textContent.startsWith('Observed')")
                        with page.expect_download() as activity_download:
                            page.get_by_role("button", name="Export agent activity CSV", exact=True).click()
                        activity_csv = Path(activity_download.value.path()).read_text(encoding="utf-8-sig")
                        self.assertIn("Session-wide activity", activity_csv)
                        self.assertIn("<Synthetic builder>", activity_csv)
                        self.assertIn("NOT_CHECKED", activity_csv)
                        page.route("**/api/get_agent_activity", lambda route: route.fulfill(
                            status=500, content_type="application/json", body='{"error":"Synthetic monitoring failure"}'))
                        page.get_by_role("button", name="Refresh agent activity", exact=True).click()
                        page.get_by_text("Agent observation failed:", exact=False).wait_for()
                        self.assertEqual(page.locator("#agent-sessions table").count(), 0)
                        self.assertTrue(page.locator("#agents-export").is_disabled())
                        page.unroute("**/api/get_agent_activity")
                        page.get_by_role("button", name="Refresh agent activity", exact=True).click()
                        page.locator("#agent-sessions").get_by_text("<Synthetic builder>", exact=True).wait_for()
                        monitored_run = page.locator("#run-select").input_value()
                        page.route("**/api/get_state", lambda route: route.fulfill(
                            status=500, content_type="application/json", body='{"error":"Synthetic state failure"}'))
                        page.locator("#run-select").select_option("")
                        page.get_by_text("Synthetic state failure", exact=True).wait_for()
                        self.assertEqual(page.locator("#agent-sessions table").count(), 0)
                        self.assertTrue(page.locator("#agents-export").is_disabled())
                        page.unroute("**/api/get_state")
                        page.locator("#run-select").select_option(monitored_run)
                        page.locator("#agent-sessions").get_by_text("<Synthetic builder>", exact=True).wait_for()
                        page.get_by_role("button", name="Assessment", exact=True).click()
                        page.get_by_role("button", name="Refresh evidence").click()
                        page.get_by_role("button", name="Planning summary", exact=True).click()
                        page.get_by_role("heading", name="Migration planning picture", exact=True).wait_for()
                        panels = page.locator("#assessment-planning .planning-section")
                        self.assertEqual(panels.count(), 6)
                        for panel in panels.all():
                            summary = panel.locator(":scope > summary")
                            self.assertIsNone(panel.get_attribute("open"))
                            self.assertFalse(panel.locator(".table-wrap").is_visible())
                            summary.click()
                            self.assertIsNotNone(panel.get_attribute("open"))
                            self.assertTrue(panel.locator(".table-wrap").is_visible())
                            summary.focus()
                            summary.press("Enter")
                            self.assertIsNone(panel.get_attribute("open"))
                            summary.press("Space")
                            self.assertIsNotNone(panel.get_attribute("open"))
                            self.assertTrue(panel.locator(".table-wrap").is_visible())
                        project_panel = panels.filter(has=page.get_by_role("heading", name="By project", exact=True))
                        project_panel.locator(":scope > summary").press("Space")
                        self.assertIsNone(project_panel.get_attribute("open"))
                        page.get_by_role("button", name="Evidence", exact=True).click()
                        page.get_by_role("button", name="Planning summary", exact=True).click()
                        self.assertIsNone(project_panel.get_attribute("open"))
                        project_panel.locator(":scope > summary").click()
                        self.assertEqual(page.locator("#planning-workbook-count").inner_text(), "101")
                        self.assertEqual(page.locator("#planning-project-count").inner_text(), "2")
                        self.assertEqual(page.locator("#planning-datasource-count").inner_text(), "1")
                        self.assertEqual(page.locator("#planning-published-count").inner_text(), "2")
                        self.assertEqual(page.locator("#planning-lifetime-count").inner_text().replace(",", ""), "2020")
                        self.assertIn("101 known / 0 unknown", page.locator("#planning-lifetime-coverage").inner_text())
                        self.assertEqual(page.locator(".assessment-overview svg[role=img]").count(), 3)
                        self.assertIn("Review: 100", page.locator("#planning-overview-recommendations").inner_text())
                        self.assertIn("40+: 100", page.locator("#planning-overview-complexity").inner_text())
                        self.assertIn("Top 20 account for 19.8%", page.locator("#planning-overview-usage").inner_text())
                        self.assertEqual(page.locator("#planning-overview-usage polyline").count(), 1)
                        def assert_coverage(percent, count):
                            marker = page.locator("#planning-overview-usage .usage-coverage-marker")
                            self.assertEqual(marker.count(), 1)
                            self.assertEqual(marker.locator(".usage-coverage-percent").text_content(), f"{percent}% coverage")
                            self.assertIn(f"Top {count} workbooks cover {percent}%", marker.get_attribute("aria-label"))
                            self.assertIn("of 2,020 views", marker.locator("title").text_content())
                            marker.hover()
                            marker.focus()
                            self.assertTrue(marker.evaluate("(e) => e === document.activeElement"))
                            self.assertTrue(marker.evaluate("""e => {
                                const svg=e.ownerSVGElement;
                                const [x,y]=svg.querySelector('polyline').getAttribute('points').split(' ').at(-1).split(',').map(Number);
                                const dot=e.querySelector('circle'), box=e.querySelector('rect').getBBox();
                                return Number(dot.getAttribute('cx'))===x && Number(dot.getAttribute('cy'))===y
                                    && box.x>=0 && box.y>=0 && box.x+box.width<=360 && box.y+box.height<=180;
                            }"""))
                        assert_coverage("19.8", 20)
                        top_slider = page.locator("#planning-usage-top")
                        self.assertEqual(top_slider.input_value(), "20")
                        self.assertEqual(top_slider.get_attribute("max"), "101")
                        top_slider.focus()
                        top_slider.press("ArrowRight")
                        self.assertEqual(page.locator("#planning-overview-usage svg > rect").count(), 21)
                        self.assertIn("Top 21 account for 20.8%", page.locator("#planning-overview-usage").inner_text())
                        assert_coverage("20.8", 21)
                        top_slider.focus()
                        top_slider.press("End")
                        self.assertEqual(top_slider.input_value(), "101")
                        self.assertEqual(page.locator("#planning-overview-usage svg > rect").count(), 101)
                        self.assertEqual(page.locator("#planning-overview-usage ol li").count(), 101)
                        self.assertIn("Top 101 account for 100.0%", page.locator("#planning-overview-usage").inner_text())
                        self.assertTrue(page.locator("#planning-overview-usage svg > rect").evaluate_all(
                            "(bars) => bars.every(b => Number(b.getAttribute('width')) <= 288/101)"))
                        assert_coverage("100.0", 101)
                        top_slider.focus()
                        top_slider.press("Home")
                        self.assertEqual(top_slider.input_value(), "1")
                        self.assertIn("Top 1 account for 1.0%", page.locator("#planning-overview-usage").inner_text())
                        assert_coverage("1.0", 1)
                        page.get_by_role("button", name="Refresh evidence", exact=True).click()
                        page.locator("#refresh:enabled").wait_for()
                        self.assertEqual(top_slider.input_value(), "1")
                        self.assertFalse(top_slider.is_disabled())
                        active_run = page.locator("#run-select").input_value()
                        page.locator("#run-select").select_option("")
                        page.locator("#run-select:enabled").wait_for()
                        self.assertTrue(top_slider.is_disabled())
                        page.locator("#run-select").select_option(active_run)
                        page.locator("#run-select:enabled").wait_for()
                        self.assertEqual(top_slider.input_value(), "20")
                        page.set_viewport_size({"width": 390, "height": 844})
                        self.assertTrue(page.locator(".assessment-overview").evaluate(
                            "(e) => e.getBoundingClientRect().right <= window.innerWidth"))
                        page.set_viewport_size({"width": 1440, "height": 1100})
                        project_panel.locator(":scope > summary").click()
                        page.get_by_role("link", name="By project", exact=True).click()
                        self.assertIsNotNone(project_panel.get_attribute("open"))
                        self.assertEqual(page.locator("#planning-projects tr").count(), 2)
                        self.assertEqual(page.locator("#planning-views tr").count(), 2)
                        self.assertIn("19", page.locator("#planning-views tr").first.inner_text())
                        self.assertEqual(page.locator("#planning-catalog tr").count(), 2)
                        self.assertIn("1 LUID-linked / 0 candidate", page.locator("#planning-datasources").inner_text())
                        self.assertIn("1 duplicate rows collapsed", page.locator("#planning-coverage").inner_text())
                        self.assertTrue(page.locator("#planning-use-selection").is_disabled())
                        self.assertEqual(page.locator("#planning-workbooks tr").count(), 50)
                        headline = lambda key: page.locator(f'#planning-headlines [data-metric="{key}"] strong').inner_text().replace(",", "")
                        self.assertEqual(headline("candidates"), "101")
                        self.assertEqual(headline("usage"), "2020")
                        self.assertEqual(headline("dashboards"), "101")
                        self.assertEqual(headline("score"), "4012")
                        self.assertEqual(page.locator("#planning-tier").count(), 1)
                        self.assertIsNone(page.locator("#planning-filter-menu").get_attribute("open"))
                        page.locator("#planning-filter-menu > summary").click()
                        page.locator("#planning-attribute-search").fill("understated")
                        self.assertEqual(page.locator("#planning-attribute-grid > details:visible").count(), 1)
                        page.locator("#planning-attr-understated-mode").select_option("yes")
                        self.assertEqual(headline("candidates"), "1")
                        self.assertEqual(headline("score"), "12")
                        self.assertEqual(page.locator("#planning-views tr").count(), 1)
                        self.assertIn("1 active attribute filters", page.locator("#planning-active-filters").inner_text())
                        page.locator("#planning-attribute-search").fill("size")
                        self.assertEqual(headline("candidates"), "1")
                        page.locator("#planning-attr-sizeMb-mode").select_option("range")
                        self.assertIn("at least one bound", page.locator("#planning-filter-error").inner_text())
                        self.assertEqual(page.locator("#planning-views tr").count(), 0)
                        self.assertTrue(page.locator("#planning-filtered-export").is_disabled())
                        page.locator("#planning-attr-sizeMb-min").fill("4")
                        page.locator("#planning-attr-sizeMb-max").fill("3")
                        self.assertIn("minimum must not exceed", page.locator("#planning-filter-error").inner_text())
                        page.locator("#planning-attr-sizeMb-min").fill("3")
                        self.assertEqual(headline("candidates"), "1")
                        self.assertEqual(page.locator("#planning-filter-error").inner_text(), "")
                        with page.expect_download() as attribute_download:
                            page.get_by_role("button", name="Export filtered workbooks & views CSV", exact=True).click()
                        attribute_csv = Path(attribute_download.value.path()).read_text(encoding="utf-8-sig")
                        self.assertIn("attributes", attribute_csv)
                        self.assertIn("understated", attribute_csv)
                        self.assertIn('"source-001"', attribute_csv)
                        self.assertNotIn('"view-orphan"', attribute_csv)
                        self.assertNotIn('"large-source-1"', attribute_csv)
                        page.get_by_role("button", name="Reset chart & workbook filters", exact=True).click()
                        self.assertEqual(headline("candidates"), "101")
                        self.assertEqual(page.locator("#planning-attr-sizeMb-mode").input_value(), "")
                        self.assertEqual(page.locator("#planning-attr-understated-mode").input_value(), "")
                        self.assertEqual(page.locator("#planning-attribute-search").input_value(), "")
                        self.assertIn("0 active", page.locator("#planning-active-filters").inner_text())
                        self.assertIn("101 filtered candidate", page.locator("#planning-chart-status").inner_text())
                        self.assertEqual(page.locator("#planning-scatter circle").count(), 101)
                        self.assertFalse(page.locator("#planning-date-from").is_disabled())
                        self.assertIn("99 unknown", page.locator("#planning-date-coverage").inner_text())
                        page.locator("#planning-date-from").focus()
                        page.locator("#planning-date-from").press("ArrowRight")
                        self.assertEqual(page.locator("#planning-after").input_value(), "2025-12-31")
                        self.assertEqual(page.locator("#planning-before").input_value(), "2026-01-02")
                        self.assertEqual(page.locator("#planning-workbooks tr").count(), 1)
                        self.assertEqual(headline("candidates"), "1")
                        self.assertEqual(page.locator("#planning-date-from-value").inner_text(), "2025-12-31")
                        page.locator("#planning-after").fill("2025-12-30")
                        self.assertEqual(page.locator("#planning-date-from").input_value(),
                                         page.locator("#planning-date-from").get_attribute("min"))
                        self.assertEqual(page.locator("#planning-workbooks tr").count(), 2)
                        page.locator("#planning-date-through").focus()
                        page.locator("#planning-date-through").press("Home")
                        self.assertEqual(page.locator("#planning-after").input_value(), "2025-12-30")
                        self.assertEqual(page.locator("#planning-before").input_value(), "2025-12-30")
                        self.assertIn("Synthetic workload 1", page.locator("#planning-workbooks").inner_text())
                        page.get_by_role("button", name="Clear date range (include unknown)", exact=True).click()
                        self.assertEqual(page.locator("#planning-after").input_value(), "")
                        self.assertEqual(page.locator("#planning-before").input_value(), "")
                        self.assertIn("101 filtered candidate", page.locator("#planning-chart-status").inner_text())
                        page.locator("#planning-chart-usage").get_by_role("button", name="10-99 lifetime views:", exact=False).click()
                        self.assertEqual(page.locator("#planning-chart-usage :focus").count(), 1)
                        self.assertEqual(page.locator("#planning-minViews").input_value(), "10")
                        self.assertEqual(page.locator("#planning-maxViews").input_value(), "99")
                        page.locator("#planning-chart-complexity").get_by_role("button", name="Score 1-39:", exact=False).click()
                        self.assertEqual(page.locator("#planning-workbooks tr").count(), 1)
                        self.assertEqual(page.locator("#planning-scatter circle").count(), 1)
                        self.assertEqual(headline("candidates"), "1")
                        self.assertEqual(headline("usage"), "20")
                        self.assertIn("1 filtered candidate", page.locator("#planning-chart-status").inner_text())
                        with page.expect_download() as chart_download:
                            page.get_by_role("button", name="Export filtered workbooks & views CSV", exact=True).click()
                        chart_csv = Path(chart_download.value.path()).read_text(encoding="utf-8-sig")
                        self.assertIn('"source-001"', chart_csv)
                        self.assertNotIn('"large-source-1"', chart_csv)
                        page.get_by_role("button", name="Reset chart & workbook filters", exact=True).click()
                        self.assertEqual(page.locator("#planning-band").input_value(), "")
                        self.assertEqual(page.locator("#planning-maxViews").input_value(), "")
                        page.get_by_role("button", name="Next workbooks", exact=True).click()
                        self.assertIn("51-100 of 101", page.locator("#planning-page-label").inner_text())
                        self.assertEqual(headline("candidates"), "101")
                        page.get_by_role("button", name="Next workbooks", exact=True).click()
                        self.assertEqual(page.locator("#planning-workbooks tr").count(), 1)
                        self.assertTrue(page.locator("#planning-next").is_disabled())
                        page.locator("#planning-tier").select_option("migrate")
                        self.assertEqual(page.locator("#planning-workbooks tr").count(), 1)
                        self.assertTrue(page.locator("#planning-use-selection").is_enabled())
                        page.locator("#planning-tier").select_option("")
                        page.locator("#planning-detail > summary").click()
                        self.assertIsNone(page.locator("#planning-detail").get_attribute("open"))
                        page.locator("#planning-projects tr").filter(has_text="Large synthetic project").get_by_role("button", name="Review workbooks").click()
                        self.assertIsNotNone(page.locator("#planning-detail").get_attribute("open"))
                        self.assertIn("of 100", page.locator("#planning-page-label").inner_text())
                        self.assertTrue(page.locator("#planning-use-selection").is_enabled())
                        page.locator("#planning-datasources").get_by_role("button", name="Review consumers").click()
                        self.assertEqual(page.locator("#planning-workbooks tr").count(), 1)
                        self.assertIn("2026-01-02T03:04:05.000Z", page.locator("#planning-workbooks").inner_text())
                        page.locator("#planning-project").select_option("luid:project-001")
                        page.locator("#planning-band").select_option("lower")
                        page.locator("#planning-usage").select_option("used")
                        page.locator("#planning-after").fill("2026-01-02")
                        page.locator("#planning-before").fill("2026-01-02")
                        page.locator("#planning-signal").select_option("deliberate")
                        self.assertEqual(page.locator("#planning-workbooks tr").count(), 1)
                        self.assertEqual(page.locator("#planning-views tr").count(), 1)
                        self.assertEqual(page.locator("#planning-catalog tr").count(), 1)
                        page.locator("#planning-project").select_option("luid:project-large")
                        self.assertEqual(page.locator("#planning-workbooks tr").count(), 0)
                        self.assertTrue(page.locator("#planning-use-selection").is_disabled())
                        page.locator("#planning-project").select_option("luid:project-001")
                        page.locator("#planning-after").fill("2026-02-01")
                        self.assertIn("must not be later", page.locator("#planning-filter-error").inner_text())
                        self.assertTrue(page.locator("#planning-filtered-export").is_disabled())
                        page.locator("#planning-after").fill("2026-01-02")
                        with page.expect_download() as filtered_download:
                            page.get_by_role("button", name="Export filtered workbooks & views CSV", exact=True).click()
                        filtered_csv = Path(filtered_download.value.path()).read_text(encoding="utf-8-sig")
                        self.assertIn('"source-001"', filtered_csv)
                        self.assertIn('"view-001"', filtered_csv)
                        self.assertNotIn('"view-orphan"', filtered_csv)
                        self.assertNotIn('"large-source-1"', filtered_csv)
                        page.locator("#planning-view-search").fill("no matching view")
                        self.assertEqual(page.locator("#planning-views tr").count(), 0)
                        page.locator("#planning-view-search").fill("")
                        with page.expect_download() as planning_download:
                            page.get_by_role("button", name="Export assessment summary CSV", exact=True).click()
                        planning_csv = Path(planning_download.value.path()).read_text(encoding="utf-8-sig")
                        self.assertIn('"project_summary"', planning_csv)
                        self.assertIn('"datasource_summary"', planning_csv)
                        self.assertIn('"complexity_summary"', planning_csv)
                        self.assertIn("NOT_CHECKED", planning_csv)
                        page.locator("#planning-attr-understated-mode").select_option("yes")
                        page.get_by_role("button", name="Use filtered workbooks in batch", exact=True).click()
                        self.assertEqual(page.locator("#selection-count").inner_text(), "1 selected")
                        page.get_by_role("button", name="Batch creation", exact=True).click()
                        page.locator("#work-rows").get_by_text("<Synthetic & safe>", exact=True).wait_for()
                        page.get_by_role("checkbox", name="Select workbook <Synthetic & safe>").check()
                        page.locator("#batch-form [name=label]").fill("Browser regression wave")
                        page.locator("#batch-form [name=stage]").select_option("conversion")
                        page.locator("#batch-form [name=numeric]").select_option("required")
                        page.get_by_role("button", name="Approve & queue batch").click()
                        page.get_by_text("Batch queued, not running.", exact=False).wait_for()
                        self.assertEqual(page.locator("#batch-title").inner_text(), "Browser regression wave")
                        self.assertIn("get_dispatch", page.locator("#handoff").input_value())
                        page.locator("#update-form [name=sessionId]").fill("synthetic-browser-session")
                        page.locator("#update-form [name=note]").fill("Browser regression started")
                        page.get_by_role("button", name="Record transition").click()
                        page.get_by_text("Progress recorded.", exact=False).wait_for()
                        page.locator("#update-form [name=status]").select_option("finished")
                        page.locator("#update-form [name=evidence]").fill("synthetic-browser-signoff.json")
                        page.locator("#update-form [name=note]").fill("Synthetic stage finished")
                        page.get_by_role("button", name="Record transition").click()
                        page.get_by_text("synthetic-browser-signoff.json", exact=False).wait_for()
                        with page.expect_download() as downloaded:
                            page.get_by_role("button", name="Export progress CSV").click()
                        content = Path(downloaded.value.path()).read_text(encoding="utf-8-sig")
                        self.assertIn('"finished (operator-reported)"', content)
                        self.assertIn("synthetic-browser-signoff.json", content)
                        self.assertIn("NOT_CHECKED", content)
                        page.reload()
                        self.assertTrue(page.locator("#assessment").is_visible())
                        page.locator("nav [data-tab=batches]").click()
                        page.locator(".batch-card").filter(has_text="Browser regression wave").get_by_role("button", name="Open track").click()
                        self.assertIn("Synthetic stage finished", page.locator("#event-list").inner_text())
                        page.locator("nav [data-tab=history]").click()
                        page.locator("#register-form [name=run]").fill(context["external"])
                        page.get_by_role("button", name="Register run", exact=True).click()
                        page.get_by_text("Existing run registered.", exact=False).wait_for()
                        self.assertIn("external-synthetic-run", page.locator("#history-rows").inner_text())
                        page.set_viewport_size({"width": 600, "height": 900})
                        self.assertTrue(page.locator("nav [data-tab=overview]").is_visible())
                        page.get_by_role("button", name="Batch creation", exact=True).click()
                        page.locator("#source-form [name=sourceKind]").select_option("project")
                        self.assertEqual(page.locator("#source-value").get_attribute("type"), "text")
                        page.locator("#source-form [name=label]").fill("One-off project browser")
                        page.locator("#source-form [name=value]").fill("Exact Synthetic Project")
                        page.locator("#source-form [name=numeric]").select_option("none")
                        page.get_by_role("button", name="Approve & queue one-off").click()
                        page.get_by_text("One-off batch queued without assessment.", exact=False).wait_for()
                        self.assertIn("Exact Synthetic Project", page.locator("#batch-info").inner_text())
                        self.assertIn("No run allocated yet", page.locator("#batch-info").inner_text())
                        self.assertEqual(failures, [])
                    finally:
                        browser.close()
            finally:
                process.stdin.close()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
                stderr = process.stderr.read()
                process.stdout.close()
                process.stderr.close()
            self.assertEqual(process.returncode, 0, stderr)


if __name__ == "__main__":
    unittest.main()
