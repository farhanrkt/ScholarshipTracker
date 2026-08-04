/**
 * Seed index pages for discovery.
 *
 * "All scholarships in the world" has no registry, so discovery is seeded, not
 * magic. These are pages that LIST many programmes; the crawler follows their
 * outbound links, their pagination, and any sub-listings it finds, then
 * classifies what it lands on.
 *
 * CURATE THIS LIST — it is the single biggest lever on what the database ends
 * up containing. A run reports every seed that failed to fetch, so bad URLs
 * surface on the first pass rather than silently contributing nothing.
 *
 * Three things to keep in mind when adding:
 *  - Prefer official funders, ministries, and university aid indexes over
 *    commercial aggregators. Aggregators are denser but their terms usually
 *    prohibit scraping, and their data is second-hand anyway.
 *  - Check robots.txt allows the path. The crawler enforces this, but a
 *    disallowed seed just wastes a slot.
 *  - Verify before committing: `npm run discover:verify -- <url>` fetches the
 *    page and counts programme-shaped links using the crawler's own scorer.
 *    Anything under five is not pulling its weight.
 */

export interface Seed {
  /** Index page to crawl. */
  url: string;
  /** Shown in logs and stored on each candidate. */
  label: string;
  /** Follow links off this domain? True for portals that link out to funders. */
  followExternal: boolean;
  /** Hint recorded on candidates found here; the classifier can override it. */
  country?: string;
}

/**
 * Verified 2026-08-02 with `npm run discover:verify`. The count on each entry
 * is programme-shaped links found on the seed page itself — pagination and
 * sub-listings are followed at run time and add to it.
 *
 * Re-check after any run that reports a seed as unreachable.
 */
export const SEEDS: Seed[] = [
  /* ------------------------------------------------------------------ USA */
  {
    // ON WATCH: 5 links when first verified, 2 on 2026-08-03. The site has
    // reshuffled its programme pages under /current-fulbrighters/, which is an
    // internal-audience path and correctly rejected — so the drop is real and
    // not a scoring bug. Kept because it is the front door of the largest US
    // programme and costs one fetch, but if the next sweep still says 2, this
    // seed is not earning its slot and the FLTA/Humphrey rows are better added
    // by hand.
    url: "https://foreign.fulbrightonline.org/",
    label: "Fulbright Foreign Student",
    followExternal: false,
    country: "USA",
  },
  {
    // 5 on page one, and a real pager (/scholarships-programs/page/2..6) that
    // discovery now follows — this seed is worth several times its first page.
    url: "https://www.iie.org/programs/",
    label: "IIE programmes",
    followExternal: false,
    country: "USA",
  },
  {
    // 10 links.
    url: "https://www.humphreyfellowship.org/",
    label: "Hubert H. Humphrey Fellowship",
    followExternal: false,
    country: "USA",
  },
  {
    // 10 links, and the internal/external fellowship indexes it links to are
    // themselves listings.
    url: "https://gsas.harvard.edu/financial-support/fellowships",
    label: "Harvard GSAS fellowships",
    followExternal: false,
    country: "USA",
  },
  {
    // 8 links.
    url: "https://www.pdsoros.org/",
    label: "Paul & Daisy Soros Fellowships",
    followExternal: false,
    country: "USA",
  },
  {
    // 6 links, and the grant pages live on my.rotary.org — the one seed here
    // that genuinely needs to leave its origin. No country hint: Rotary funds
    // study in many countries.
    url: "https://www.rotary.org/en/our-programs/scholarships",
    label: "Rotary Foundation",
    followExternal: true,
  },
  {
    // 108 programme-shaped links — the densest US source found so far, and
    // second only to Edinburgh overall. Verified 2026-08-03.
    url: "https://grad.berkeley.edu/financial/fellowships/",
    label: "UC Berkeley graduate fellowships",
    followExternal: false,
    country: "USA",
  },
  {
    // 14 links. Verified 2026-08-03.
    url: "https://grad.arizona.edu/funding",
    label: "University of Arizona graduate funding",
    followExternal: false,
    country: "USA",
  },
  {
    // 13 links. Verified 2026-08-03.
    url: "https://gradschool.unc.edu/funding/",
    label: "UNC Chapel Hill graduate funding",
    followExternal: false,
    country: "USA",
  },
  {
    // 10 links. Verified 2026-08-03.
    url: "https://grad.msu.edu/funding",
    label: "Michigan State graduate funding",
    followExternal: false,
    country: "USA",
  },
  {
    // 9 links, and named awards rather than category pages — the /funding/
    // parent scored 6 and is mostly navigation, so this is the better door.
    // Verified 2026-08-03.
    url: "https://grad.ucla.edu/funding/fellowships/",
    label: "UCLA graduate fellowships",
    followExternal: false,
    country: "USA",
  },
  {
    // 6 links. Thin, but it is Stanford's own graduate aid index and cheap.
    // Verified 2026-08-03.
    url: "https://financialaid.stanford.edu/grad/",
    label: "Stanford graduate financial aid",
    followExternal: false,
    country: "USA",
  },

  /* ------------------------------------------------------------------- UK */
  {
    // 18 links.
    url: "https://www.chevening.org/scholarships/",
    label: "Chevening",
    followExternal: false,
    country: "UK",
  },
  {
    // 11 links plus a working /page/2. The Commonwealth Scholarship Commission
    // is the densest official UK source we have.
    url: "https://cscuk.fcdo.gov.uk/scholarships/",
    label: "Commonwealth Scholarship Commission",
    followExternal: false,
    country: "UK",
  },
  {
    // 467 programme-shaped links — an entire funding database in one page.
    // Expect this seed alone to saturate a run's per-seed budget.
    url: "https://www.ed.ac.uk/student-funding/postgraduate/international",
    label: "University of Edinburgh funding",
    followExternal: false,
    country: "UK",
  },
  {
    // 19 links.
    url: "https://www.leeds.ac.uk/scholarships",
    label: "University of Leeds",
    followExternal: false,
    country: "UK",
  },
  {
    // 16 links, split by degree level.
    url: "https://www.ucl.ac.uk/scholarships/",
    label: "UCL scholarships",
    followExternal: false,
    country: "UK",
  },
  {
    // 15 links.
    url: "https://www.manchester.ac.uk/study/international/finance-and-scholarships/funding/",
    label: "University of Manchester",
    followExternal: false,
    country: "UK",
  },
  {
    // 9 links.
    url: "https://www.gla.ac.uk/scholarships/",
    label: "University of Glasgow",
    followExternal: false,
    country: "UK",
  },
  {
    // 14 links off 181 on the page. Verified 2026-08-03.
    url: "https://le.ac.uk/study/scholarships",
    label: "University of Leicester",
    followExternal: false,
    country: "UK",
  },
  {
    // 6 links, split by degree level. Verified 2026-08-03.
    url: "https://www.exeter.ac.uk/study/funding/",
    label: "University of Exeter funding",
    followExternal: false,
    country: "UK",
  },

  /* ---------------------------------------------------------------- Japan */
  {
    // 5 links. The government's own index — MEXT, JASSO, and local government
    // schemes all hang off it.
    url: "https://www.studyinjapan.go.jp/en/planning/scholarships/",
    label: "Study in Japan (MEXT)",
    followExternal: false,
    country: "Japan",
  },
  {
    // 5 links, one per study level.
    url: "https://www.jasso.go.jp/ryugaku/scholarship_a/index.html",
    label: "JASSO scholarships",
    followExternal: false,
    country: "Japan",
  },
  {
    // 7 links.
    url: "https://www.u-tokyo.ac.jp/en/prospective-students/scholarships.html",
    label: "University of Tokyo",
    followExternal: false,
    country: "Japan",
  },
  {
    // 25 programme-shaped links AND a real four-page pager (?p=2..4) — by a
    // wide margin the densest Japanese source that serves static HTML, and the
    // only one found that paginates at all.
    //
    // The one directory in this list rather than a funder: it is run by the
    // Asia Students Cultural Association, its robots.txt permits the path (the
    // crawler enforces that and it fetched clean), and the alternative for
    // Japan is three university pages of five links each. The programme pages
    // it links to are still read from the funder's own site by extraction, so
    // nothing second-hand reaches the database. Verified 2026-08-03.
    url: "https://www.jpss.jp/en/scholarship/",
    label: "JPSS scholarship directory",
    followExternal: true,
    country: "Japan",
  },

  /* ---------------------------------------------------------- South Korea */
  {
    // 15 links — by far the best Korean source that serves static HTML.
    url: "https://oga.snu.ac.kr/students/incoming/degree-program/scholarship",
    label: "Seoul National University",
    followExternal: false,
    country: "South Korea",
  },
  {
    // 5 links. The GKS pages proper are JavaScript-rendered; the front page
    // still links to enough static content to be worth the fetch.
    url: "https://www.studyinkorea.go.kr/en/main.do",
    label: "Study in Korea (GKS)",
    followExternal: false,
    country: "South Korea",
  },

  /* ---------------------------------------------------------------- China */
  {
    // 7 links. China is the hardest region to seed — see BLOCKED_SEEDS.
    url: "https://global.sjtu.edu.cn/en/study-sjtu/prospective/scholarships",
    label: "Shanghai Jiao Tong University",
    followExternal: false,
    country: "China",
  },
  {
    // ON WATCH: 5 links when first verified, 4 on 2026-08-03, and its
    // top-scoring links are now news posts about faculty grants. Kept only
    // because China has two seeds in total and both are needed — see the note
    // on why more cannot simply be added.
    url: "https://www.dukekunshan.edu.cn/admissions/undergraduate/financial-aid/",
    label: "Duke Kunshan University",
    followExternal: false,
    country: "China",
  },

  /* ------------------------------------------------------------ Singapore */
  {
    // 38 links.
    url: "https://www.ntu.edu.sg/admissions/graduate/financialmatters/scholarships",
    label: "NTU Singapore",
    followExternal: false,
    country: "Singapore",
  },
  {
    // 20 links.
    url: "https://www.a-star.edu.sg/Scholarships",
    label: "A*STAR Singapore",
    followExternal: false,
    country: "Singapore",
  },
  {
    // 14 links.
    url: "https://www.moe.gov.sg/financial-matters/awards-scholarships",
    label: "Singapore MOE",
    followExternal: false,
    country: "Singapore",
  },
];

/**
 * Known-bad seeds, kept as a record so nobody re-adds them without a fix.
 *
 * Four failure modes recur, and you should expect to hit them again while
 * curating. None is worth working around for a single site — find a different
 * entry point, or add the programme by hand.
 *
 *  BOT-BLOCKED (HTTP 403/412 to any non-browser client)
 *    https://www.campuschina.org/
 *    https://www.csc.edu.cn/laihua
 *    https://study-uk.britishcouncil.org/scholarships
 *    https://www.eastwestcenter.org/education/scholarships-fellowships
 *    https://www.aauw.org/resources/programs/fellowships-grants/
 *    https://gradschool.cornell.edu/financial-support/fellowships/
 *
 *  CLIENT-RENDERED (fetches fine, yields no links in the HTML)
 *    https://www.daad.de/en/study-and-research-in-germany/scholarships/
 *    https://www.nus.edu.sg/oam/scholarships
 *    https://www.smu.edu.sg/admissions/undergraduate/scholarships
 *    https://www.fudan.edu.cn/en/1401/list.htm
 *
 *  GONE (404 as of the verification date — these move often, re-check rather
 *  than assuming they are dead forever)
 *    https://www.imperial.ac.uk/study/fees-and-funding/postgraduate-taught/scholarships/
 *    https://www.studyinkorea.go.kr/en/sub/gks/allnew_invite.do
 *    https://www.kaist.ac.kr/en/html/edu/0205.html
 *    https://www.tsinghua.edu.cn/en/Admissions/Scholarships.htm
 *    https://is.tsinghua.edu.cn/en/Admissions/Scholarships.htm
 *    https://yenchingacademy.pku.edu.cn/ADMISSIONS/Financial_Aid.htm
 *    https://www.waseda.jp/inst/cie/en/scholarship/
 *
 *  A NOTE ON YIELD. Of ~23 further candidates tested on 2026-08-03, exactly one
 *  (Berkeley) qualified: university funding pages 403 or 404 far more often
 *  than they work, and national portals are mostly client-rendered. Hunting new
 *  seeds by guessing URLs has poor returns. The bigger lever now is HARVESTING
 *  the seeds already listed — Edinburgh alone carries 467 programme-shaped
 *  links, Berkeley 108, NTU 38 — which is a matter of running discovery with a
 *  real --per-seed budget, not of adding more entries here.
 *
 *  A SECOND ROUND, 2026-08-03: 40 more candidates tested, 9 qualified. The hit
 *  rate is entirely a function of WHERE you look, and the split is worth
 *  knowing before spending another afternoon on this:
 *
 *    US graduate schools   5 of 9   — by far the best return. `grad.<school>`
 *                                     and `gradschool.<school>` on a `.edu`
 *                                     serve static HTML and index real awards.
 *    UK universities       2 of 12  — high 403/404 rate; the ones that work are
 *                                     dense (Leicester 14, Edinburgh 467).
 *    Japan                 1 of 7   — JPSS, and it is worth more than the other
 *                                     six put together.
 *    China                 0 of 8
 *    South Korea           0 of 9
 *
 *  CHINA AND SOUTH KOREA ARE NOT A CURATION PROBLEM. Every candidate tested in
 *  both failed for a reason no seed list can fix: DNS/connection failure from
 *  outside the region (en.pku.edu.cn, iso.ustc.edu.cn, en.nju.edu.cn,
 *  en.sysu.edu.cn, oia.korea.edu, admissions.kaist.ac.kr, oia.kaist.ac.kr),
 *  client-rendered shells (admission.yonsei.ac.kr, en.westlake.edu.cn),
 *  robots.txt denial (iss.snu.ac.kr), or a moved path (postech, hanyang,
 *  cuhk.edu.cn, nyush, studyinkorea's board). Two more — oia.snu.ac.kr and
 *  global.sjtu.edu.cn/en/ — fetch fine but carry 4 programme-shaped links each,
 *  and both point mostly at pages we already seed.
 *
 *  So coverage for those two countries needs a different mechanism, not more
 *  URLs: a headless browser for the client-rendered portals, or hand-entered
 *  rows that extraction then fills in. Adding more `.cn`/`.kr` guesses here
 *  will not help, and this list is the record of that having been tried twice.
 *
 *  TOO THIN (reachable, under five programme-shaped links — a single-programme
 *  page dressed as an index)
 *    https://www.gatescambridge.org/apply/          (2)
 *    https://knight-hennessy.stanford.edu/          (2)
 *    https://www.jasso.go.jp/en/study_j/scholarships/index.html (2 — use the
 *                                                    /ryugaku/ path instead)
 *    https://www.schwarzmanscholars.org/admissions/ (0)
 */
export const BLOCKED_SEEDS = [
  "https://www.campuschina.org/",
  "https://www.csc.edu.cn/laihua",
  "https://study-uk.britishcouncil.org/scholarships",
  "https://www.eastwestcenter.org/education/scholarships-fellowships",
  "https://www.aauw.org/resources/programs/fellowships-grants/",
  "https://gradschool.cornell.edu/financial-support/fellowships/",
  "https://www.daad.de/en/study-and-research-in-germany/scholarships/",
  "https://www.nus.edu.sg/oam/scholarships",
  "https://www.smu.edu.sg/admissions/undergraduate/scholarships",
  "https://www.fudan.edu.cn/en/1401/list.htm",
  // Tested 2026-08-03. 403: durham.ac.uk/study/scholarships,
  // gradschool.princeton.edu, acls.org, ssrc.org, wilsoncenter.org, acu.ac.uk,
  // kaist.ac.kr, nus.edu.sg/registrar. 404: birmingham, bristol, sheffield,
  // warwick, nottingham, mit.edu graduate-education.
  "https://www.durham.ac.uk/study/scholarships/",
  "https://gradschool.princeton.edu/costs-funding/sources-funding",
  "https://www.acls.org/fellowships/",
  "https://www.ssrc.org/fellowships/",
  "https://www.wilsoncenter.org/fellowships-grants",
  "https://www.acu.ac.uk/get-involved/commonwealth-scholarships/",
  // Round two, 2026-08-03. 403: suss.edu.sg, qub.ac.uk, cardiff.ac.uk,
  // grad.ucdavis.edu, qmul.ac.uk. Client-rendered: singaporetech.edu.sg,
  // admission.yonsei.ac.kr, en.westlake.edu.cn. Unreachable from outside the
  // region: the .cn and .kr hosts listed in the note above. 404 (paths move —
  // re-check rather than assuming dead): kyoto-u, tsukuba, osaka-u, tohoku,
  // keio, sutd, kcl, bath, lancaster, york, sheffield, ncl, surrey, grad.uw.
  "https://www.suss.edu.sg/full-time-undergraduate/financial-matters/scholarships-awards",
  "https://www.qub.ac.uk/Study/international-students/scholarships/",
  "https://www.cardiff.ac.uk/study/international/scholarships-and-finance",
  "https://grad.ucdavis.edu/resources/fellowships",
  "https://www.qmul.ac.uk/scholarships/",
  "https://www.singaporetech.edu.sg/admissions/undergraduate/scholarships",
  "https://admission.yonsei.ac.kr/",
  "https://en.westlake.edu.cn/admissions_aid/",
  "https://iss.snu.ac.kr/",
] as const;
