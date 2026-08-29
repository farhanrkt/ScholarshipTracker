import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { groundExtraction, groundProfile, isEmpty, isEmptyProfile } from "./ground.ts";
import type { FetchedPage } from "./page.ts";
import type { CycleExtraction, ProfileExtraction } from "./schema.ts";

/**
 * Grounding is the control the whole product rests on: it is what separates
 * "the model read it off the page" from "the model produced something
 * plausible". Every test here is a value that must be KEPT or a value that must
 * be THROWN AWAY, and the ones that must be thrown away matter most — a
 * fabricated deadline or an invented stipend reaches a student as fact.
 */

function page(text: string, url = "https://example.org/a"): FetchedPage {
  return { url, text, html: "", sha256: "x", fetchedAt: "2026-08-03T00:00:00Z" };
}

const claim = (value: string | null, quote: string | null) => ({
  value,
  evidence_quote: quote,
  confidence: "high" as const,
});

function cycle(patch: Partial<CycleExtraction> = {}): CycleExtraction {
  return {
    page_subject: "Test programme",
    page_is_about_requested_programme: true,
    cycle_label: claim(null, null),
    opens_date: claim(null, null),
    deadline_date: claim(null, null),
    timeline: [],
    notes_for_reviewer: "",
    ...patch,
  };
}

describe("cycle grounding", () => {
  test("keeps a date whose quote is on the page and states day, month and year", () => {
    const result = groundExtraction(
      cycle({ deadline_date: claim("2026-10-06", "Applications close on 6 October 2026") }),
      [page("Applications close on 6 October 2026 at 11:00 UTC.")],
      "https://example.org/a",
    );

    assert.equal(result.proposed.deadline_date, "2026-10-06");
    assert.deepEqual(result.ungroundedFields, []);
  });

  test("drops a date whose quote is nowhere on the page", () => {
    const result = groundExtraction(
      cycle({ deadline_date: claim("2026-10-06", "Applications close on 6 October 2026") }),
      [page("This page says nothing about deadlines at all, at length.")],
      "https://example.org/a",
    );

    assert.equal(result.proposed.deadline_date, null);
    assert.match(result.ungroundedFields[0] ?? "", /quote not found/);
  });

  test("drops an invented day when the page only gave a month", () => {
    // The real Gates Cambridge failure: "opens in September 2026" became
    // 2026-09-01 and a student would have planned around a date nobody set.
    const result = groundExtraction(
      cycle({ opens_date: claim("2026-09-01", "Applications will open again in September 2026") }),
      [page("Applications will open again in September 2026, watch this space.")],
      "https://example.org/a",
    );

    assert.equal(result.proposed.opens_date, null);
    assert.match(result.ungroundedFields[0] ?? "", /does not state the day/);
  });

  test("rejects a quote too short to be evidence", () => {
    // "2026" matches almost any page by accident.
    const result = groundExtraction(
      cycle({ deadline_date: claim("2026-10-06", "2026") }),
      [page("Something about 2026 and other things entirely, at some length.")],
      "https://example.org/a",
    );

    assert.equal(result.proposed.deadline_date, null);
  });

  test("drops a malformed date regardless of its quote", () => {
    const result = groundExtraction(
      cycle({ deadline_date: claim("6 October 2026", "Applications close on 6 October 2026") }),
      [page("Applications close on 6 October 2026 at 11:00 UTC.")],
      "https://example.org/a",
    );

    assert.equal(result.proposed.deadline_date, null);
    assert.match(result.ungroundedFields[0] ?? "", /malformed/);
  });

  test("keeps a conditional date but records a caveat for the reviewer", () => {
    const quote = "either Tuesday 8th December 2026 or Wednesday 6th January 2027 (see Course Directory)";
    const result = groundExtraction(
      cycle({ deadline_date: claim("2026-12-08", quote) }),
      [page(`The deadline is ${quote}.`)],
      "https://example.org/a",
    );

    assert.equal(result.proposed.deadline_date, "2026-12-08");
    assert.equal(result.caveats.length, 1);
  });

  test("records the page that held the quote as the source, not the entry URL", () => {
    const result = groundExtraction(
      cycle({ deadline_date: claim("2026-10-06", "Applications close on 6 October 2026") }),
      [
        page("A landing page with nothing useful on it whatsoever, at length.", "https://example.org/home"),
        page("Applications close on 6 October 2026.", "https://example.org/timeline"),
      ],
      "https://example.org/home",
    );

    assert.equal(result.bestSourceUrl, "https://example.org/timeline");
  });

  test("an undated but named timeline stage is kept", () => {
    const result = groundExtraction(
      cycle({
        timeline: [
          { key: "interviews", label: "Interviews", date: null, note: null, evidence_quote: null },
        ],
      }),
      [page("Interviews happen at some point in the spring, we are told.")],
      "https://example.org/a",
    );

    assert.equal(result.proposed.timeline.length, 1);
    assert.equal(result.proposed.timeline[0]?.date, null);
    assert.equal(isEmpty(result), true, "no dates anywhere means empty");
  });
});

/* -------------------------------------------------------------------------- */

const num = (value: number | null, quote: string | null) => ({ value, evidence_quote: quote });
const bool = (value: boolean | null, quote: string | null) => ({ value, evidence_quote: quote });
const strs = (values: string[], quote: string | null) => ({ values, evidence_quote: quote });

function profile(patch: Partial<ProfileExtraction> = {}): ProfileExtraction {
  return {
    page_subject: "Test programme",
    page_is_about_requested_programme: true,
    coverage: [],
    eligibility: {
      max_age: num(null, null),
      min_gpa_4_scale: num(null, null),
      min_work_experience_years: num(null, null),
      language_test_required: bool(null, null),
      accepted_language_tests: strs([], null),
      min_toefl_ibt: num(null, null),
      min_ielts: num(null, null),
      requires_university_admission_first: bool(null, null),
      requires_government_nomination: bool(null, null),
      requires_research_proposal: bool(null, null),
      restricted_to_nationalities: strs([], null),
      notes: null,
    },
    documents: [],
    fields_of_study: strs([], null),
    award_duration: claim(null, null),
    number_of_awards: claim(null, null),
    post_study_obligations: claim(null, null),
    language_training_included: bool(null, null),
    not_stated: [],
    notes_for_reviewer: "",
    ...patch,
  };
}

describe("profile grounding", () => {
  test("keeps a coverage figure that appears in its own quote", () => {
    const result = groundProfile(
      profile({
        coverage: [
          {
            key: "monthly_stipend",
            covered: true,
            detail: "JPY 143,000 per month",
            evidence_quote: "a monthly stipend of JPY 143,000",
          },
        ],
      }),
      [page("Recipients receive a monthly stipend of JPY 143,000 while studying.")],
    );

    assert.equal(result.proposed.coverage_matrix.monthly_stipend?.detail, "JPY 143,000 per month");
  });

  test("strips an invented figure but keeps the line it was attached to", () => {
    // The quote is real and does say a stipend exists. The amount is not in it.
    const result = groundProfile(
      profile({
        coverage: [
          {
            key: "monthly_stipend",
            covered: true,
            detail: "USD 2,500 per month",
            evidence_quote: "The award covers a maintenance allowance",
          },
        ],
      }),
      [page("The award covers a maintenance allowance for the duration of study.")],
    );

    assert.equal(result.proposed.coverage_matrix.monthly_stipend?.covered, true);
    assert.equal(result.proposed.coverage_matrix.monthly_stipend?.detail, null);
    assert.match(result.ungroundedFields[0] ?? "", /does not contain that figure/);
  });

  test("accepts numbers the page spells out in words", () => {
    // "a minimum of five years" is how eligibility pages actually write it; a
    // digits-only check discarded correct, properly quoted values.
    const result = groundProfile(
      profile({
        eligibility: {
          ...profile().eligibility,
          min_work_experience_years: num(5, "Have a minimum of five years of professional experience"),
          max_age: num(35, "applicants must be under the age of thirty-five"),
        },
      }),
      [
        page(
          "Have a minimum of five years of professional experience. Also, applicants must be under the age of thirty-five.",
        ),
      ],
    );

    assert.equal(result.proposed.eligibility_flags.min_work_experience_years, 5);
    assert.equal(result.proposed.eligibility_flags.max_age, 35);
  });

  test("rejects a number that is not in its quote", () => {
    const result = groundProfile(
      profile({
        eligibility: {
          ...profile().eligibility,
          min_toefl_ibt: num(100, "Have a minimum of five years of professional experience"),
        },
      }),
      [page("Have a minimum of five years of professional experience, we require.")],
    );

    assert.equal(result.proposed.eligibility_flags.min_toefl_ibt, undefined);
  });

  test("keeps list values named in the quote and drops the rest", () => {
    const result = groundProfile(
      profile({
        eligibility: {
          ...profile().eligibility,
          accepted_language_tests: strs(
            ["Test of English as a Foreign Language (TOEFL)", "IELTS"],
            "Accepted tests: Test of English as a Foreign Language (TOEFL).",
          ),
        },
      }),
      [page("Accepted tests: Test of English as a Foreign Language (TOEFL). Nothing else.")],
    );

    assert.deepEqual(result.proposed.eligibility_flags.accepted_language_tests, [
      "Test of English as a Foreign Language (TOEFL)",
    ]);
    assert.match(result.ungroundedFields[0] ?? "", /IELTS/);
  });

  test("matches an acronym against its expansion", () => {
    // The page writes the full name; the model returns the acronym, or vice
    // versa. Both are the page's own words.
    const result = groundProfile(
      profile({
        eligibility: {
          ...profile().eligibility,
          accepted_language_tests: strs(
            ["TOEFL"],
            "we accept the Test of English as a Foreign Language (TOEFL)",
          ),
        },
      }),
      [page("For entry we accept the Test of English as a Foreign Language (TOEFL) only.")],
    );

    assert.deepEqual(result.proposed.eligibility_flags.accepted_language_tests, ["TOEFL"]);
  });

  test("gives colliding document slugs distinct keys", () => {
    // These become the ids in checklist_progress; a collision would make two
    // documents tick as one.
    const quote = "Two academic references are required";
    const result = groundProfile(
      profile({
        documents: [
          { key: "reference", label: "Reference", required: true, note: null, evidence_quote: quote },
          { key: "reference", label: "Reference", required: true, note: null, evidence_quote: quote },
        ],
      }),
      [page("Two academic references are required for every application.")],
    );

    const keys = result.proposed.document_checklist.map((doc) => doc.key);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
  });

  test("an ungrounded document is dropped entirely", () => {
    const result = groundProfile(
      profile({
        documents: [
          {
            key: "transcripts",
            label: "Transcripts",
            required: true,
            note: null,
            evidence_quote: "Certified academic transcripts must be supplied",
          },
        ],
      }),
      [page("This page discusses the weather and nothing else, at some length.")],
    );

    assert.deepEqual(result.proposed.document_checklist, []);
    assert.equal(isEmptyProfile(result), true);
  });

  test("zero years of experience survives without a digit in the quote", () => {
    // Pages say "no work experience is required", never "0 years".
    const result = groundProfile(
      profile({
        eligibility: {
          ...profile().eligibility,
          min_work_experience_years: num(0, "No work experience is required to apply"),
        },
      }),
      [page("No work experience is required to apply for this award.")],
    );

    assert.equal(result.proposed.eligibility_flags.min_work_experience_years, 0);
  });
});

describe("month-precision dates", () => {
  const quote = "Applications will open again in September 2026";

  test("a month without a day never becomes a date", () => {
    // The damage this prevents: 2026-09-01 is a day nobody published, and a
    // student plans around it.
    const result = groundExtraction(
      cycle({ opens_date: claim("2026-09-01", quote) }),
      [page(`${quote}. Check back then for details of the next round.`)],
      "https://example.org/a",
    );

    assert.equal(result.proposed.opens_date, null);
    assert.match(result.ungroundedFields[0] ?? "", /does not state the day/);
  });

  test("but the month survives as an undated stage carrying the page's words", () => {
    const result = groundExtraction(
      cycle({ opens_date: claim("2026-09-01", quote) }),
      [page(`${quote}. Check back then for details of the next round.`)],
      "https://example.org/a",
    );

    const stage = result.proposed.timeline.find((item) => item.key === "opens");
    assert.ok(stage, "the month-only date was lost entirely");
    assert.equal(stage.date, null);
    assert.match(stage.note ?? "", /month but not the day/);
    assert.match(stage.note ?? "", /September 2026/);
  });

  test("the rescue is not mistaken for an empty extraction", () => {
    // isEmpty() gates whether anything reaches review at all. Without the
    // explicit flag, a rescued stage reads as "no dates found" and the whole
    // extraction is binned — undoing the rescue.
    const result = groundExtraction(
      cycle({ opens_date: claim("2026-09-01", quote) }),
      [page(`${quote}. Check back then for details of the next round.`)],
      "https://example.org/a",
    );

    assert.equal(isEmpty(result), false);
  });

  test("a stage the model already published is not duplicated", () => {
    const result = groundExtraction(
      cycle({
        opens_date: claim("2026-09-01", quote),
        timeline: [
          { key: "opens", label: "Round opens", date: null, note: null, evidence_quote: null },
        ],
      }),
      [page(`${quote}. Check back then for details of the next round.`)],
      "https://example.org/a",
    );

    assert.equal(result.proposed.timeline.filter((s) => s.key === "opens").length, 1);
  });

  test("a missing YEAR is still a total loss, not a rescue", () => {
    // "closes on 6 October" with no year could be any year; there is nothing
    // safe to keep, so nothing is kept.
    const result = groundExtraction(
      cycle({ deadline_date: claim("2026-10-06", "Applications close on 6 October") }),
      [page("Applications close on 6 October. See the portal for the current round.")],
      "https://example.org/a",
    );

    assert.equal(result.proposed.deadline_date, null);
    assert.equal(result.proposed.timeline.length, 0);
    assert.equal(isEmpty(result), true);
  });
});

describe("scope of the award", () => {
  test("duration and count are kept as published, not parsed", () => {
    const text =
      "Awards are tenable for up to 3 years. Approximately 1,500 scholarships are offered each year.";
    const result = groundProfile(
      profile({
        award_duration: claim("up to 3 years", "tenable for up to 3 years"),
        number_of_awards: claim(
          "Approximately 1,500 each year",
          "Approximately 1,500 scholarships are offered each year",
        ),
      }),
      [page(text)],
    );

    assert.equal(result.proposed.award_duration, "up to 3 years");
    assert.equal(result.proposed.number_of_awards, "Approximately 1,500 each year");
  });

  test("a duration whose figure is not in its quote is discarded", () => {
    // The near-miss that reads as authoritative: a real quote about tenure,
    // with a number nobody published attached to it.
    const result = groundProfile(
      profile({
        award_duration: claim("up to 4 years", "Awards are tenable for up to 3 years"),
      }),
      [page("Awards are tenable for up to 3 years, subject to good progress.")],
      );

    assert.equal(result.proposed.award_duration, null);
    assert.match(result.ungroundedFields[0] ?? "", /does not contain that figure/);
  });

  test("a subject restriction is kept item by item", () => {
    const text =
      "This award is open only to applicants in Engineering and Public Health disciplines.";
    const result = groundProfile(
      profile({
        fields_of_study: strs(
          ["Engineering", "Public Health", "Law"],
          "open only to applicants in Engineering and Public Health disciplines",
        ),
      }),
      [page(text)],
    );

    // "Law" is in the model's list and not in the quote, so it goes.
    assert.deepEqual(result.proposed.fields_of_study, ["Engineering", "Public Health"]);
    assert.match(result.ungroundedFields[0] ?? "", /dropped "Law"/);
  });

  test("scope alone is enough to be worth a reviewer's time", () => {
    // isEmptyProfile gates whether the profile half reaches review at all.
    const result = groundProfile(
      profile({
        award_duration: claim("one academic year", "funded for one academic year"),
      }),
      [page("The fellowship is funded for one academic year, renewable once.")],
    );

    assert.equal(isEmptyProfile(result), false);
  });

  test("an unread programme stays empty", () => {
    assert.equal(isEmptyProfile(groundProfile(profile(), [page("Nothing here.")])), true);
  });
});

/* -------------------------------------------------------------------------- */
/* Near-miss quotes                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Grounding used to answer "is this on the page?" with a substring search, and
 * a substring search says no to things that plainly are on the page: a quote
 * stitched across a bullet, a dropped article, a tab out of a table cell.
 * Every one of those discarded a correct value and left the row emptier than
 * the site.
 *
 * The rule that makes the looser match safe is that support checks now read
 * the PAGE TEXT that matched, not the model's quote — so a number the page
 * never printed cannot ride in on a quote that is otherwise accurate.
 */
describe("quotes that miss the page by a word", () => {
  test("a date whose quote stitched across a bullet is kept", () => {
    const result = groundExtraction(
      cycle({
        deadline_date: claim(
          "2026-10-06",
          "Applications close on 6 October 2026 Interviews are held in March 2027",
        ),
      }),
      [page("Applications close on 6 October 2026\n· Interviews are held in March 2027")],
      "https://example.org/a",
    );

    assert.equal(result.proposed.deadline_date, "2026-10-06");
    assert.deepEqual(result.ungroundedFields, []);
    assert.equal(result.evidence.deadline_date?.match, "loose");
  });

  test("an exactly quoted date is still recorded as an exact match", () => {
    const result = groundExtraction(
      cycle({ deadline_date: claim("2026-10-06", "Applications close on 6 October 2026") }),
      [page("Applications close on 6 October 2026 at 12:00 midday UK time.")],
      "https://example.org/a",
    );

    assert.equal(result.evidence.deadline_date?.match, "exact");
  });

  test("a stipend figure the page never printed is still discarded", () => {
    // The whole quote but the number is on the page. Under a token-overlap
    // rule alone this would ground, and a student would budget against a
    // figure nobody published.
    const result = groundProfile(
      profile({
        coverage: [
          {
            key: "monthly_stipend",
            covered: true,
            detail: "GBP 1,347 per month",
            evidence_quote:
              "The award covers a monthly stipend of GBP 1,347 towards your living costs in London",
          },
        ],
      }),
      [page("The award covers a monthly stipend towards your living costs in London.")],
    );

    assert.equal(result.proposed.coverage_matrix.monthly_stipend, undefined);
    assert.match(result.ungroundedFields[0] ?? "", /quote not found/);
  });

  test("a near-miss quote keeps the figure the page did print", () => {
    const result = groundProfile(
      profile({
        coverage: [
          {
            key: "monthly_stipend",
            covered: true,
            detail: "GBP 1,347 per month",
            evidence_quote:
              "Chevening covers monthly stipend of GBP 1,347 for living expenses in the UK",
          },
        ],
      }),
      [page("Chevening covers a monthly stipend of GBP 1,347 for living expenses in the UK.")],
    );

    assert.equal(result.proposed.coverage_matrix.monthly_stipend?.detail, "GBP 1,347 per month");
    assert.equal(result.evidence["coverage.monthly_stipend"]?.match, "loose");
  });

  test("a fabricated quote is rejected as comprehensively as before", () => {
    const result = groundProfile(
      profile({
        eligibility: {
          ...profile().eligibility,
          max_age: num(35, "Applicants must be under the age of 35 on the closing date"),
        },
      }),
      [page("This page is about the history of the foundation and its founders.")],
    );

    assert.equal(result.proposed.eligibility_flags.max_age, undefined);
    assert.match(result.ungroundedFields[0] ?? "", /quote not found/);
  });
});

/* -------------------------------------------------------------------------- */
/* "The pages do not say" as an answer                                        */
/* -------------------------------------------------------------------------- */

/**
 * A missing key and a read-and-silent page used to be the same absence in
 * `eligibility_flags`, so the "No work experience required" filter matched
 * every row nobody had opened. Recording the difference is what lets a query
 * refuse to answer "unknown" as "no".
 */
describe("eligibility questions the pages did not answer", () => {
  test("an explicit null is recorded as asked-and-silent", () => {
    const result = groundProfile(
      profile({
        eligibility: {
          ...profile().eligibility,
          max_age: num(null, null),
          min_work_experience_years: num(null, null),
        },
      }),
      [page("A page about the programme that mentions no limits at all.")],
    );

    assert.equal(result.eligibilitySilent.includes("max_age"), true);
    assert.equal(result.eligibilitySilent.includes("min_work_experience_years"), true);
  });

  test("an empty list is silence too", () => {
    const result = groundProfile(
      profile({
        eligibility: { ...profile().eligibility, accepted_language_tests: strs([], null) },
      }),
      [page("A page about the programme that names no language tests.")],
    );

    assert.equal(result.eligibilitySilent.includes("accepted_language_tests"), true);
  });

  test("a claim that failed grounding is NOT recorded as silence", () => {
    // The distinction that makes this trustworthy. We asked, something came
    // back, and it was not usable — which leaves the question unanswered, not
    // answered "no". Calling it silence would let a rejected hallucination
    // become a positive claim on the row.
    const result = groundProfile(
      profile({
        eligibility: {
          ...profile().eligibility,
          max_age: num(35, "Applicants must be under the age of 35 on the closing date"),
        },
      }),
      [page("This page is about the history of the foundation and its founders.")],
    );

    assert.equal(result.proposed.eligibility_flags.max_age, undefined);
    assert.equal(result.eligibilitySilent.includes("max_age"), false);
  });

  test("a question that was answered carries no marker", () => {
    const result = groundProfile(
      profile({
        eligibility: {
          ...profile().eligibility,
          max_age: num(35, "applicants must be under the age of 35"),
        },
      }),
      [page("For this award, applicants must be under the age of 35 at the deadline.")],
    );

    assert.equal(result.proposed.eligibility_flags.max_age, 35);
    assert.equal(result.eligibilitySilent.includes("max_age"), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Dates from a cycle that has already been and gone                          */
/* -------------------------------------------------------------------------- */

/**
 * The Richard Rockefeller Fellowship row carried deadline_date 2019-12-09,
 * grounded and quoted and stamped verified in 2026, read off a page the funder
 * left up and never took down. Grounding cannot catch that and never could —
 * the quote is real and the date is real. A programme runs annually, so a date
 * more than a cycle before the crawl is simply not this cycle's.
 */
describe("archived cycles", () => {
  const CRAWLED = "2026-08-06T00:00:00Z";
  const old = (text: string) => ({
    url: "https://example.org/a",
    text,
    html: "",
    sha256: "x",
    fetchedAt: CRAWLED,
  });

  test("a deadline from seven years ago is dropped", () => {
    const result = groundExtraction(
      cycle({
        deadline_date: claim("2019-12-09", "Applications are due by 9 December 2019"),
      }),
      [old("Applications are due by 9 December 2019 for the coming year.")],
      "https://example.org/a",
    );

    assert.equal(result.proposed.deadline_date, null);
    assert.match(result.ungroundedFields[0] ?? "", /archived cycle/);
  });

  test("a deadline that has only just passed survives, with a caveat", () => {
    // Programmes publish next year's dates months after the last round shuts.
    // Dropping these would empty every row that is merely between cycles.
    const result = groundExtraction(
      cycle({
        deadline_date: claim("2026-05-18", "Applications close on 18 May 2026"),
      }),
      [old("Applications close on 18 May 2026 at midnight.")],
      "https://example.org/a",
    );

    assert.equal(result.proposed.deadline_date, "2026-05-18");
    assert.match(result.caveats.join(" "), /already passed/);
  });

  test("a future deadline passes without comment", () => {
    const result = groundExtraction(
      cycle({
        deadline_date: claim("2026-10-06", "Applications close on 6 October 2026"),
      }),
      [old("Applications close on 6 October 2026 at midday.")],
      "https://example.org/a",
    );

    assert.equal(result.proposed.deadline_date, "2026-10-06");
    assert.deepEqual(result.caveats, []);
  });

  test("an archived timeline stage keeps its name and loses its date", () => {
    const result = groundExtraction(
      cycle({
        timeline: [
          {
            key: "interviews",
            label: "Interviews",
            date: "2019-03-11",
            note: null,
            evidence_quote: "Interviews are held on 11 March 2019",
          },
        ],
      }),
      [old("Interviews are held on 11 March 2019 in Washington.")],
      "https://example.org/a",
    );

    assert.equal(result.proposed.timeline[0]?.label, "Interviews");
    assert.equal(result.proposed.timeline[0]?.date, null);
    assert.match(result.ungroundedFields[0] ?? "", /archived cycle/);
  });
});

describe("recorded silence", () => {
  test("a reported not-stated field is kept", () => {
    // The difference between a card that shows nothing and a card that says
    // "the programme does not state this". The second is an answer; the first
    // leaves the reader deciding whether the award excludes flights or whether
    // nobody checked, with nothing to decide it with.
    const result = groundProfile(
      profile({ not_stated: ["coverage.airfare", "award_duration"] }),
      [page("The award covers tuition fees in full for the whole programme.")],
    );

    assert.deepEqual(result.silentFields, ["award_duration", "coverage.airfare"]);
  });

  test("a field the same response filled is NOT reported as unstated", () => {
    // A model can contradict itself: name a field in `not_stated` and return a
    // value for it anyway. The value survived grounding, so it is the half
    // worth keeping — and a row carrying both would render a figure next to
    // "not stated by the programme".
    const result = groundProfile(
      profile({
        coverage: [
          {
            key: "airfare",
            covered: true,
            detail: null,
            evidence_quote: "The award covers a return airfare to the home country.",
          },
        ],
        not_stated: ["coverage.airfare"],
      }),
      [page("The award covers a return airfare to the home country.")],
    );

    assert.deepEqual(result.silentFields, []);
    assert.equal(result.proposed.coverage_matrix.airfare?.covered, true);
  });

  test("a key the schema never asked about is discarded", () => {
    // A model naming something outside the field list is not answering any
    // question we asked, and letting it through would put an arbitrary string
    // into a column the UI reads by key.
    const result = groundProfile(
      profile({ not_stated: ["coverage.private_jet", "", "eligibility.max_age"] }),
      [page("A page about a scholarship programme, at some reasonable length.")],
    );

    assert.deepEqual(result.silentFields, ["eligibility.max_age"]);
  });
});
