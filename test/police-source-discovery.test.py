"""Data-quality checks: python3 test/police-source-discovery.test.py"""
import csv
import importlib.util
import io
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("discovery", ROOT / "scripts/discover-police-sources.py")
discovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(discovery)
spec = importlib.util.spec_from_file_location("report", ROOT / "scripts/build-police-source-report.py")
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)
spec = importlib.util.spec_from_file_location("nixle", ROOT / "scripts/discover-police-nixle.py")
nixle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nixle)


class DiscoveryTest(unittest.TestCase):
    def test_nixle_directory_neighbours_do_not_become_city_publishers(self):
        self.assertFalse(nixle.city_publisher("SBSD - Chino Hills Police Department", "Chino"))
        self.assertFalse(nixle.city_publisher("Madera County Sheriff's Office", "Madera"))
        self.assertTrue(nixle.city_publisher("SBSD - Chino Hills Police Department", "Chino Hills"))
        self.assertTrue(nixle.city_publisher("City of Davis Police", "Davis"))
        self.assertTrue(nixle.city_publisher("San Mateo, CA Police Department", "San Mateo"))

    def test_population_threshold_and_whole_governments(self):
        base = {"SUMLEV": "162", "STATE": "06", "COUNTY": "000", "PLACE": "12345", "COUSUB": "00000", "CONCIT": "00000", "FUNCSTAT": "A", "NAME": "Example city", "STNAME": "California", "POPESTIMATE2025": "20001"}
        rows = [base, {**base, "PLACE": "12346", "POPESTIMATE2025": "20000"}, {**base, "SUMLEV": "157"}, {**base, "SUMLEV": "050"}, {**base, "FUNCSTAT": "S"}, {**base, "SUMLEV": "061", "COUNTY": "001", "COUSUB": "12347", "NAME": "Example township"}]
        text = io.StringIO()
        writer = csv.DictWriter(text, fieldnames=base)
        writer.writeheader()
        writer.writerows(rows)
        gaz = "USPS|GEOID|INTPTLAT|INTPTLONG\nCA|0612345|37.25|-121.9\nCA|0600112347|37.3|-121.8\n"
        places = discovery.municipalities(text.getvalue(), [gaz], minimum_population=20000)
        self.assertEqual({p["id"] for p in places}, {"162:0612345", "061:0600112347"})
        self.assertTrue(all(p["population"] > 20000 for p in places))

    def test_same_named_places_in_other_states_are_not_domain_matches(self):
        place = {"state": "CA", "name": "Campbell"}
        row = {"Domain type": "City", "State": "OH", "City": "Campbell", "Organization name": "City of Campbell", "Suborganization name": "", "Domain name": "campbellohio.gov"}
        self.assertEqual(discovery.government_domains(place, [row]), [])

    def test_social_share_buttons_and_city_footer_accounts_are_excluded(self):
        for url in ("https://twitter.com/intent/tweet?text=Police", "https://facebook.com/sharer/sharer.php?u=Police", "https://x.com/CityOfExample"):
            self.assertIsNone(discovery.channel({"url": url, "text": "", "type": ""}, True))
        self.assertEqual(discovery.channel({"url": "https://twitter.com/ExamplePD", "text": "", "type": ""}, True), "x")

    def test_nixle_registration_is_not_a_public_archive(self):
        for url in ("https://local.nixle.com/register/", "https://local.nixle.com/accounts/login/", "https://local.nixle.com/zipcode/94530/"):
            self.assertIsNone(discovery.channel({"url": url, "text": "", "type": ""}, True))
        self.assertEqual(discovery.channel({"url": "https://local.nixle.com/example-police-department/", "text": "", "type": ""}, True), "nixle")

    def test_translations_and_tracking_dedupe_without_losing_feed_categories(self):
        self.assertEqual(discovery.canonical(" https://twitter.com/ExamplePD?ref_src=abc "), "https://x.com/examplepd")
        url = discovery.canonical("https://example.gov/RSSFeed.aspx?ModID=1&CID=Police-5&oc_lang=es")
        self.assertIn("ModID=1", url)
        self.assertIn("CID=Police-5", url)
        self.assertNotIn("oc_lang", url)

    def test_calendar_and_generic_city_feeds_are_not_crime_feeds(self):
        def row(url):
            return {"kind": "feed-candidate", "url": url, "evidence_url": "https://example.gov/rss.aspx", "verification": "candidate"}
        channels = report.clean_channels([row("https://example.gov/RSSFeed.aspx?ModID=58&CID=Police-8"), row("https://example.gov/RSSFeed.aspx?ModID=1&CID=Library-9"), row("https://example.gov/RSSFeed.aspx?ModID=1&CID=Police-5")])
        self.assertEqual([c["kind"] for c in channels], ["calendar-feed", "feed-candidate"])

    def test_report_does_not_allow_data_to_end_the_script(self):
        page = report.render([{"name": "</script><script>alert(1)</script>"}], {})
        self.assertNotIn("</script><script>alert(1)", page)
        self.assertIn("\\u003c/script>", page)


if __name__ == "__main__":
    unittest.main()
