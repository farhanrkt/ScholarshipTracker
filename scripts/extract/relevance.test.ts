import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  bestTopic,
  hasDeadlineLanguage,
  scoreLinkTopics,
  scoreText,
  scoreTopics,
} from "./relevance.ts";

/**
 * The scorer decides what gets crawled and what reaches the model, so its
 * failures are silent: a page that scores zero is simply never seen, and the
 * row it would have filled in stays empty for reasons nothing logs.
 *
 * Every "real page" case below is a URL that actually cost us data.
 */

describe("date scoring", () => {
  test("a date next to deadline language beats either signal alone", () => {
    const both = scoreText("Applications close on 6 October 2026").score;
    const languageOnly = scoreText("Applications close soon").score;
    const dateOnly = scoreText("Published 6 October 2026").score;

    assert.ok(both > languageOnly + dateOnly);
  });

  test("a bare year is not a date", () => {
    assert.equal(scoreText("Copyright 2026").hasDate, false);
  });
});

describe("topic routing of real pages", () => {
  const cases: Array<[string, string, string]> = [
    ["dates", "Application timeline", "https://x.example/scholarships/application-timeline"],
    // Chevening's actual eligibility page. Scored ZERO under the date-only
    // vocabulary, so the crawler never fetched it.
    ["eligibility", "Who can apply", "https://x.example/scholarships/who-can-apply"],
    // Humphrey's actual benefits page, likewise invisible.
    ["benefits", "Fellowship components", "https://x.example/how-to-apply/fellowship-components"],
    ["benefits", "What you get", "https://x.example/awards/what-you-get"],
    ["documents", "Required documents", "https://x.example/apply/required-documents"],
    ["process", "How to apply", "https://x.example/apply/how-to-apply"],
  ];

  for (const [expected, label, url] of cases) {
    test(`${url.split("/").pop()} routes to ${expected}`, () => {
      const { topic, score } = bestTopic(scoreLinkTopics(label, url));
      assert.equal(topic, expected);
      assert.ok(score >= 6, `scored ${score}, below the crawl threshold`);
    });
  }

  test("a privacy policy is below the threshold on every topic", () => {
    const { score } = bestTopic(scoreLinkTopics("Privacy policy", "https://x.example/privacy-policy"));
    assert.ok(score < 6, `privacy policy scored ${score}`);
  });
});

describe("one-word nav links", () => {
  /**
   * Every one of these scored ZERO before NAV_TERMS existed, so the page was
   * dropped from the frontier before it was ever fetched. `/benefits` is the
   * expensive one: it is where the coverage matrix lives, and its absence is
   * why extracted rows carried a deadline and nothing about the money.
   */
  const cases: Array<[string, string, string]> = [
    ["benefits", "Benefits", "https://x.example/benefits/"],
    ["benefits", "Funding", "https://x.example/funding/"],
    ["benefits", "Fees and costs", "https://x.example/fees/"],
    ["benefits", "What we offer", "https://x.example/what-we-offer/"],
    ["benefits", "Scholarship value", "https://x.example/award/value/"],
    ["process", "Apply", "https://x.example/apply/"],
    ["process", "Guidelines", "https://x.example/guidelines/"],
    ["eligibility", "Requirements", "https://x.example/requirements/"],
    ["eligibility", "Eligibility", "https://x.example/eligibility/"],
    ["dates", "Deadlines", "https://x.example/deadlines/"],
    ["dates", "Timeline", "https://x.example/timeline/"],
    ["documents", "Checklist", "https://x.example/checklist/"],
  ];

  for (const [expected, label, url] of cases) {
    test(`"${label}" is crawlable and routes to ${expected}`, () => {
      const { topic, score } = bestTopic(scoreLinkTopics(label, url));
      // The threshold is what actually decides whether it gets fetched.
      assert.ok(score >= 6, `"${label}" scored ${score}, below the crawl threshold`);
      assert.equal(topic, expected);
    });
  }

  test("nav vocabulary does not leak into passage scoring", () => {
    // scoreTopics drives passage selection, which grounding depends on. A bare
    // "benefits" in prose must stay the weak signal it has always been, or
    // every topic blurs into every other and the passage quotas stop meaning
    // anything.
    assert.equal(scoreTopics("There are many benefits to studying abroad.").benefits, 0);
    assert.equal(scoreTopics("Apply yourself and you will do well.").process, 0);
  });

  test("chrome that happens to contain a nav word stays out", () => {
    // "Terms" is not "requirements"; "Contact" is not "apply".
    for (const [label, url] of [
      ["Contact us", "https://x.example/contact"],
      ["Terms and conditions", "https://x.example/terms"],
      ["Accessibility", "https://x.example/accessibility"],
    ] as const) {
      const { score } = bestTopic(scoreLinkTopics(label, url));
      assert.ok(score < 6, `"${label}" scored ${score} and would be crawled`);
    }
  });
});

describe("passage topics", () => {
  test("a stipend sentence is benefits, not dates", () => {
    const scores = scoreTopics(
      "Recipients receive a monthly stipend of GBP 1,347 and payment of tuition fees.",
    );
    assert.equal(bestTopic(scores).topic, "benefits");
  });

  test("a document list is documents", () => {
    const scores = scoreTopics(
      "You must submit certified academic transcripts, two reference letters and a personal statement.",
    );
    assert.equal(bestTopic(scores).topic, "documents");
  });

  test("navigation chrome scores nothing worth crawling", () => {
    const scores = scoreTopics("Home About Contact Sitemap Accessibility");
    assert.equal(bestTopic(scores).score, 0);
  });
});

describe("the dates-quota gate", () => {
  test("real date pages pass", () => {
    // These must never be dropped: the date reservation exists for them.
    for (const text of [
      "Application timeline /scholarships/application-timeline",
      "Key dates /key-dates",
      "Deadlines /deadlines",
      // "timeline" is only a MEDIUM term in prose, so a STRONG-only gate binned
      // the page named nothing else.
      "Timeline /timeline",
      "When to apply /when-to-apply",
      "Important dates /important-dates",
    ]) {
      assert.ok(hasDeadlineLanguage(text), `"${text}" was gated out`);
    }
  });

  test("merely dated pages do not", () => {
    // Each of these scores on `dates` from month and year tokens alone, clears
    // the crawl threshold, and — since ties fall to dates — would take one of
    // the five reserved date slots. Two of Chevening's five went this way.
    for (const text of [
      "2026 cohort announced /news/2026-cohort-announced",
      "Areas of impact /impact/areas-of-impact",
      "Host a fellowship /fellowships/host-a-fellowship",
      "Meet our alumni /alumni/meet-our-cheveners",
    ]) {
      assert.equal(hasDeadlineLanguage(text), false, `"${text}" was let through`);
    }
  });
});
