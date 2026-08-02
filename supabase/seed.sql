-- ScholarTrack :: seed data
-- Run AFTER schema.sql. Safe to re-run: it clears the table first.
--
-- READ THIS BEFORE TRUSTING ANY ROW
--
-- Every row lands as `verification_status = 'unverified'` with NO dates. That
-- is deliberate. The programmes, coverage and document lists are structurally
-- accurate and change slowly; the DATES change every cycle and were previously
-- reconstructed rather than sourced, which produced a wrong Chevening deadline.
--
-- A blank field is honest. A plausible wrong date is not -- it is worse than
-- nothing, because the student acts on it.
--
-- To promote a row to 'verified': open its official timeline page, read the
-- real opens/closes dates, and fill in opens_date, deadline_date, cycle_label,
-- timeline, source_url and last_verified_at. See the Chevening block at the
-- bottom of this file for the pattern.
--
-- `SELECT * FROM scholarships_needing_review;` is your worklist.

TRUNCATE scholarships CASCADE;

INSERT INTO scholarships (
    title, country, degree_levels, coverage_matrix, eligibility_flags,
    document_checklist, post_study_obligations, language_training_included,
    official_portal_url, deadline_date
) VALUES

-- ============================== USA =======================================
(
    'Fulbright Foreign Student Program',
    'USA',
    ARRAY['Masters', 'PhD'],
    '{
      "tuition":               { "covered": true,  "detail": "Full tuition and mandatory fees" },
      "monthly_stipend":       { "covered": true,  "detail": "Living stipend set by host city cost of living" },
      "airfare":               { "covered": true,  "detail": "Round-trip international travel" },
      "accommodation":         { "covered": false, "detail": "Paid out of the monthly stipend" },
      "health_insurance":      { "covered": true,  "detail": "ASPE accident and sickness cover" },
      "settling_in_allowance": { "covered": true,  "detail": "One-off arrival allowance" },
      "research_grant":        { "covered": false },
      "visa_fees":             { "covered": true,  "detail": "J-1 SEVIS fee covered" }
    }'::jsonb,
    '{
      "max_age": null,
      "min_gpa_4_scale": 3.0,
      "min_work_experience_years": 2,
      "language_test_required": true,
      "accepted_language_tests": ["TOEFL iBT", "IELTS"],
      "min_toefl_ibt": 80,
      "min_ielts": 6.5,
      "requires_university_admission_first": false,
      "requires_government_nomination": true,
      "requires_research_proposal": true,
      "restricted_to_nationalities": null,
      "notes": "Applications are routed through the Fulbright Commission in your home country."
    }'::jsonb,
    '[
      { "key": "online_form",        "label": "Online application form",              "required": true },
      { "key": "study_objective",    "label": "Study objective essay",                "required": true },
      { "key": "personal_statement", "label": "Personal statement",                   "required": true },
      { "key": "transcripts",        "label": "Official academic transcripts",        "required": true },
      { "key": "recommendations",    "label": "3 letters of recommendation",          "required": true },
      { "key": "toefl_ielts",        "label": "TOEFL iBT or IELTS score report",      "required": true },
      { "key": "gre_gmat",           "label": "GRE / GMAT (field dependent)",         "required": false },
      { "key": "cv",                 "label": "Curriculum vitae",                     "required": true },
      { "key": "passport",           "label": "Passport bio page",                    "required": true }
    ]'::jsonb,
    'Two-year home-country residency requirement (J-1 visa) before applying for a US work or immigrant visa.',
    false,
    'https://foreign.fulbrightonline.org/',
    NULL  -- deadline: unverified, must be read off the official page
),
(
    'Knight-Hennessy Scholars (Stanford)',
    'USA',
    ARRAY['Masters', 'PhD'],
    '{
      "tuition":               { "covered": true,  "detail": "Full tuition and academic fees for up to 3 years" },
      "monthly_stipend":       { "covered": true,  "detail": "Living and academic expenses stipend" },
      "airfare":               { "covered": true,  "detail": "One economy return ticket per academic year" },
      "accommodation":         { "covered": false, "detail": "Paid out of the living stipend" },
      "health_insurance":      { "covered": true },
      "settling_in_allowance": { "covered": true,  "detail": "Relocation allowance on arrival" },
      "research_grant":        { "covered": true,  "detail": "Funding for conferences and research travel" },
      "visa_fees":             { "covered": false }
    }'::jsonb,
    '{
      "max_age": null,
      "min_gpa_4_scale": 3.5,
      "min_work_experience_years": null,
      "language_test_required": true,
      "accepted_language_tests": ["TOEFL iBT", "IELTS"],
      "min_toefl_ibt": 100,
      "min_ielts": 7.0,
      "requires_university_admission_first": true,
      "requires_government_nomination": false,
      "requires_research_proposal": false,
      "restricted_to_nationalities": null,
      "notes": "Bachelor degree must have been earned within the last 7 years. Separate Stanford graduate admission is required."
    }'::jsonb,
    '[
      { "key": "online_form",        "label": "Knight-Hennessy online application",      "required": true },
      { "key": "stanford_admission", "label": "Separate Stanford programme application", "required": true },
      { "key": "essays",             "label": "Short essays and video statement",        "required": true },
      { "key": "transcripts",        "label": "Official transcripts",                    "required": true },
      { "key": "recommendations",    "label": "2 letters of recommendation",             "required": true },
      { "key": "toefl_ielts",        "label": "English proficiency score",               "required": true },
      { "key": "cv",                 "label": "Resume / CV",                             "required": true }
    ]'::jsonb,
    NULL,
    false,
    'https://knight-hennessy.stanford.edu/',
    NULL  -- deadline: unverified, must be read off the official page
),

-- ============================== UK ========================================
(
    'Chevening Scholarship',
    'UK',
    ARRAY['Masters'],
    '{
      "tuition":               { "covered": true,  "detail": "Full tuition, capped for very high-fee programmes" },
      "monthly_stipend":       { "covered": true,  "detail": "Monthly living allowance, higher rate in London" },
      "airfare":               { "covered": true,  "detail": "Return economy flights to the UK" },
      "accommodation":         { "covered": false, "detail": "Paid out of the monthly stipend" },
      "health_insurance":      { "covered": true,  "detail": "NHS access via the Immigration Health Surcharge" },
      "settling_in_allowance": { "covered": true,  "detail": "Arrival and departure allowances" },
      "research_grant":        { "covered": false },
      "visa_fees":             { "covered": true,  "detail": "Student visa application fee reimbursed" }
    }'::jsonb,
    '{
      "max_age": null,
      "min_gpa_4_scale": null,
      "min_work_experience_years": 2,
      "language_test_required": true,
      "accepted_language_tests": ["IELTS", "TOEFL iBT", "PTE Academic"],
      "min_toefl_ibt": 79,
      "min_ielts": 6.5,
      "requires_university_admission_first": false,
      "requires_government_nomination": false,
      "requires_research_proposal": false,
      "restricted_to_nationalities": null,
      "notes": "Requires 2,800 hours of qualifying work experience and three UK course choices."
    }'::jsonb,
    '[
      { "key": "online_form",     "label": "Chevening online application",            "required": true },
      { "key": "essays",          "label": "4 essays (leadership, networking, study, career)", "required": true },
      { "key": "work_experience", "label": "Work experience log (2,800 hours)",       "required": true },
      { "key": "course_choices",  "label": "3 eligible UK course choices",            "required": true },
      { "key": "transcripts",     "label": "Undergraduate transcripts and degree",    "required": true },
      { "key": "recommendations", "label": "2 references (requested after shortlist)","required": true },
      { "key": "unconditional",   "label": "Unconditional UK offer by the July deadline", "required": true },
      { "key": "passport",        "label": "Passport or national ID",                 "required": true }
    ]'::jsonb,
    'Scholars must return to their home country for a minimum of two years after the award ends.',
    false,
    'https://www.chevening.org/scholarships/',
    NULL  -- deadline: unverified, must be read off the official page
),
(
    'Gates Cambridge Scholarship',
    'UK',
    ARRAY['Masters', 'PhD'],
    '{
      "tuition":               { "covered": true,  "detail": "Full University Composition Fee at the appropriate rate" },
      "monthly_stipend":       { "covered": true,  "detail": "Maintenance allowance for the scholar" },
      "airfare":               { "covered": true,  "detail": "Return economy airfare at start and end of course" },
      "accommodation":         { "covered": false, "detail": "Paid out of the maintenance allowance" },
      "health_insurance":      { "covered": true,  "detail": "Immigration Health Surcharge covered" },
      "settling_in_allowance": { "covered": false },
      "research_grant":        { "covered": true,  "detail": "Academic development funding up to GBP 2,000" },
      "visa_fees":             { "covered": true }
    }'::jsonb,
    '{
      "max_age": null,
      "min_gpa_4_scale": 3.7,
      "min_work_experience_years": null,
      "language_test_required": true,
      "accepted_language_tests": ["IELTS", "TOEFL iBT"],
      "min_toefl_ibt": 100,
      "min_ielts": 7.5,
      "requires_university_admission_first": true,
      "requires_government_nomination": false,
      "requires_research_proposal": true,
      "restricted_to_nationalities": null,
      "notes": "Applied for inside the standard Cambridge graduate application. Not open to UK nationals."
    }'::jsonb,
    '[
      { "key": "online_form",        "label": "Cambridge graduate application (with Gates section)", "required": true },
      { "key": "gates_statement",    "label": "Gates Cambridge statement (leadership and impact)",   "required": true },
      { "key": "research_proposal",  "label": "Research proposal (PhD applicants)",                  "required": false },
      { "key": "transcripts",        "label": "Academic transcripts",                                "required": true },
      { "key": "recommendations",    "label": "3 academic references + 1 Gates reference",           "required": true },
      { "key": "toefl_ielts",        "label": "English proficiency score",                           "required": true },
      { "key": "cv",                 "label": "Curriculum vitae",                                    "required": true }
    ]'::jsonb,
    'No formal bond, but scholars are expected to commit to improving the lives of others.',
    false,
    'https://www.gatescambridge.org/',
    NULL  -- deadline: unverified, must be read off the official page
),

-- ============================== CHINA =====================================
(
    'Chinese Government Scholarship (CSC) - Type A',
    'China',
    ARRAY['Bachelors', 'Masters', 'PhD'],
    '{
      "tuition":               { "covered": true,  "detail": "Full tuition waiver at the host university" },
      "monthly_stipend":       { "covered": true,  "detail": "CNY 2,500 / 3,000 / 3,500 per month by degree level" },
      "airfare":               { "covered": false, "detail": "Not covered under most bilateral agreements" },
      "accommodation":         { "covered": true,  "detail": "Free on-campus dormitory or housing subsidy" },
      "health_insurance":      { "covered": true,  "detail": "Comprehensive insurance for international students" },
      "settling_in_allowance": { "covered": false },
      "research_grant":        { "covered": false },
      "visa_fees":             { "covered": false }
    }'::jsonb,
    '{
      "max_age": 35,
      "min_gpa_4_scale": null,
      "min_work_experience_years": null,
      "language_test_required": true,
      "accepted_language_tests": ["HSK", "IELTS", "TOEFL iBT"],
      "min_toefl_ibt": 80,
      "min_ielts": 6.0,
      "requires_university_admission_first": false,
      "requires_government_nomination": true,
      "requires_research_proposal": true,
      "restricted_to_nationalities": null,
      "notes": "Type A is nominated by your home country embassy or ministry. Age cap is 25 for Bachelors, 35 for Masters, 40 for PhD."
    }'::jsonb,
    '[
      { "key": "csc_form",          "label": "CSC online application (agency number required)", "required": true },
      { "key": "nomination",        "label": "Embassy / ministry nomination",                   "required": true },
      { "key": "transcripts",       "label": "Notarised transcripts and degree certificate",    "required": true },
      { "key": "study_plan",        "label": "Study plan or research proposal",                 "required": true },
      { "key": "recommendations",   "label": "2 recommendation letters (associate professor+)", "required": true },
      { "key": "language_cert",     "label": "HSK / IELTS / TOEFL certificate",                 "required": true },
      { "key": "medical_form",      "label": "Foreigner Physical Examination Form",             "required": true },
      { "key": "police_clearance",  "label": "Non-criminal record certificate",                 "required": true },
      { "key": "acceptance_letter", "label": "Pre-admission letter from host university",       "required": false }
    ]'::jsonb,
    'No bond. Scholarship is reviewed annually and can be withdrawn for poor academic standing.',
    true,
    'https://www.campuschina.org/',
    NULL  -- deadline: unverified, must be read off the official page
),

-- ============================== JAPAN =====================================
(
    'MEXT Scholarship - Research Student (Embassy Track)',
    'Japan',
    ARRAY['Masters', 'PhD'],
    '{
      "tuition":               { "covered": true,  "detail": "Entrance, examination and tuition fees fully waived" },
      "monthly_stipend":       { "covered": true,  "detail": "JPY 143,000-145,000 per month, regional uplift available" },
      "airfare":               { "covered": true,  "detail": "Economy flights to and from Japan" },
      "accommodation":         { "covered": false, "detail": "University housing offered at subsidised rent" },
      "health_insurance":      { "covered": false, "detail": "National Health Insurance paid from the stipend" },
      "settling_in_allowance": { "covered": false },
      "research_grant":        { "covered": false },
      "visa_fees":             { "covered": true,  "detail": "Student visa issued free of charge" }
    }'::jsonb,
    '{
      "max_age": 35,
      "min_gpa_4_scale": 2.3,
      "min_work_experience_years": null,
      "language_test_required": false,
      "accepted_language_tests": ["JLPT", "TOEFL iBT", "IELTS"],
      "min_toefl_ibt": null,
      "min_ielts": null,
      "requires_university_admission_first": false,
      "requires_government_nomination": true,
      "requires_research_proposal": true,
      "restricted_to_nationalities": null,
      "notes": "Applied through the Japanese Embassy. Written exams in English/Japanese plus interview. GPA is converted to the MEXT 3.0-on-a-2.30-scale system."
    }'::jsonb,
    '[
      { "key": "application_form",   "label": "MEXT application form",                     "required": true },
      { "key": "field_study_plan",   "label": "Field of study and research plan",          "required": true },
      { "key": "transcripts",        "label": "Academic transcripts (all years)",          "required": true },
      { "key": "degree_certificate", "label": "Degree certificate or certificate of expected graduation", "required": true },
      { "key": "recommendation",     "label": "Recommendation from your university dean/supervisor", "required": true },
      { "key": "medical_certificate","label": "Certificate of health",                     "required": true },
      { "key": "abstract_thesis",    "label": "Abstract of your thesis",                   "required": false },
      { "key": "portfolio",          "label": "Portfolio (fine arts applicants)",          "required": false },
      { "key": "language_cert",      "label": "JLPT or English proficiency certificate",   "required": false }
    ]'::jsonb,
    'No service bond. Scholars are expected to leave Japan at the end of the award unless they secure other status.',
    true,
    'https://www.studyinjapan.go.jp/en/planning/scholarship/',
    NULL  -- deadline: unverified, must be read off the official page
),
(
    'ADB-Japan Scholarship Program (JSP)',
    'Japan',
    ARRAY['Masters', 'PhD'],
    '{
      "tuition":               { "covered": true,  "detail": "Full tuition at the participating institution" },
      "monthly_stipend":       { "covered": true,  "detail": "Monthly subsistence and housing allowance" },
      "airfare":               { "covered": true,  "detail": "Economy travel at start and end of programme" },
      "accommodation":         { "covered": true,  "detail": "Housing allowance paid within the stipend" },
      "health_insurance":      { "covered": true,  "detail": "Medical insurance included" },
      "settling_in_allowance": { "covered": false },
      "research_grant":        { "covered": true,  "detail": "Books, instructional materials and thesis support" },
      "visa_fees":             { "covered": false }
    }'::jsonb,
    '{
      "max_age": 35,
      "min_gpa_4_scale": 3.0,
      "min_work_experience_years": 2,
      "language_test_required": true,
      "accepted_language_tests": ["TOEFL iBT", "IELTS"],
      "min_toefl_ibt": 80,
      "min_ielts": 6.0,
      "requires_university_admission_first": true,
      "requires_government_nomination": false,
      "requires_research_proposal": false,
      "restricted_to_nationalities": null,
      "notes": "Open to nationals of ADB borrowing member countries only. Apply directly to a participating academic institution."
    }'::jsonb,
    '[
      { "key": "institution_app",  "label": "Admission application to a participating institution", "required": true },
      { "key": "jsp_form",         "label": "ADB-JSP information sheet",                  "required": true },
      { "key": "transcripts",      "label": "Academic records",                           "required": true },
      { "key": "recommendations",  "label": "2 recommendation letters",                   "required": true },
      { "key": "employer_letter",  "label": "Employer certification of return to work",   "required": true },
      { "key": "toefl_ielts",      "label": "English proficiency score",                  "required": true },
      { "key": "medical_report",   "label": "Medical certificate",                        "required": true }
    ]'::jsonb,
    'Scholars must return to their home country after completing the programme.',
    false,
    'https://www.adb.org/work-with-us/careers/japan-scholarship-program',
    NULL  -- deadline: unverified, must be read off the official page
),

-- ============================ SOUTH KOREA =================================
(
    'Global Korea Scholarship (GKS-G) - Graduate',
    'South Korea',
    ARRAY['Masters', 'PhD'],
    '{
      "tuition":               { "covered": true,  "detail": "Full tuition, university covers any amount above the cap" },
      "monthly_stipend":       { "covered": true,  "detail": "KRW 1,200,000 per month for graduate scholars" },
      "airfare":               { "covered": true,  "detail": "Economy flights on arrival and completion" },
      "accommodation":         { "covered": false, "detail": "Dormitory paid from the monthly allowance" },
      "health_insurance":      { "covered": true,  "detail": "Medical insurance reimbursement" },
      "settling_in_allowance": { "covered": true,  "detail": "KRW 200,000 settlement allowance on arrival" },
      "research_grant":        { "covered": true,  "detail": "Thesis printing costs reimbursed" },
      "visa_fees":             { "covered": false }
    }'::jsonb,
    '{
      "max_age": 40,
      "min_gpa_4_scale": 3.0,
      "min_work_experience_years": null,
      "language_test_required": false,
      "accepted_language_tests": ["TOPIK", "TOEFL iBT", "IELTS"],
      "min_toefl_ibt": null,
      "min_ielts": null,
      "requires_university_admission_first": false,
      "requires_government_nomination": false,
      "requires_research_proposal": true,
      "restricted_to_nationalities": null,
      "notes": "Apply via either the Korean Embassy track or the university track -- one track only. A TOPIK 5-6 holder is exempt from the language year."
    }'::jsonb,
    '[
      { "key": "application_form",  "label": "GKS application form (Form 1)",             "required": true },
      { "key": "self_intro",        "label": "Personal statement (Form 2)",               "required": true },
      { "key": "study_plan",        "label": "Statement of purpose / study plan (Form 3)","required": true },
      { "key": "recommendations",   "label": "2 letters of recommendation (Form 4)",      "required": true },
      { "key": "pledge",            "label": "GKS applicant pledge (Form 5)",             "required": true },
      { "key": "self_medical",      "label": "Personal medical assessment (Form 6)",      "required": true },
      { "key": "transcripts",       "label": "Degree certificates and transcripts (apostilled)", "required": true },
      { "key": "language_cert",     "label": "TOPIK or English proficiency certificate",  "required": false },
      { "key": "citizenship_proof", "label": "Proof of citizenship for applicant and parents", "required": true },
      { "key": "awards",            "label": "Published papers and awards",               "required": false }
    ]'::jsonb,
    'No bond. Scholars must maintain a 80/100 average or the award is suspended.',
    true,
    'https://www.studyinkorea.go.kr/',
    NULL  -- deadline: unverified, must be read off the official page
),

-- ============================== SINGAPORE =================================
(
    'Singapore International Graduate Award (SINGA)',
    'Singapore',
    ARRAY['PhD'],
    '{
      "tuition":               { "covered": true,  "detail": "Full tuition for up to 4 years of PhD study" },
      "monthly_stipend":       { "covered": true,  "detail": "SGD 2,700/month, rising to SGD 3,200 after qualifying exam" },
      "airfare":               { "covered": true,  "detail": "One-off SGD 1,500 airfare grant" },
      "accommodation":         { "covered": false, "detail": "Paid out of the monthly stipend" },
      "health_insurance":      { "covered": true,  "detail": "Medical and hospitalisation cover" },
      "settling_in_allowance": { "covered": true,  "detail": "One-off SGD 1,000 settling-in allowance" },
      "research_grant":        { "covered": true,  "detail": "Conference and research allowance via the host lab" },
      "visa_fees":             { "covered": false }
    }'::jsonb,
    '{
      "max_age": null,
      "min_gpa_4_scale": 3.5,
      "min_work_experience_years": null,
      "language_test_required": true,
      "accepted_language_tests": ["TOEFL iBT", "IELTS"],
      "min_toefl_ibt": 85,
      "min_ielts": 6.0,
      "requires_university_admission_first": false,
      "requires_government_nomination": false,
      "requires_research_proposal": false,
      "restricted_to_nationalities": null,
      "notes": "Science and engineering only. GRE is strongly encouraged. Application is directly to A*STAR, not the university."
    }'::jsonb,
    '[
      { "key": "singa_form",       "label": "SINGA online application",                  "required": true },
      { "key": "transcripts",      "label": "Transcripts and degree scrolls",            "required": true },
      { "key": "recommendations",  "label": "2 referee reports",                         "required": true },
      { "key": "toefl_ielts",      "label": "TOEFL / IELTS score report",                "required": true },
      { "key": "gre",              "label": "GRE score report",                          "required": false },
      { "key": "cv",               "label": "Curriculum vitae",                          "required": true },
      { "key": "research_interest","label": "Statement of research interest and supervisor picks", "required": true }
    ]'::jsonb,
    NULL,
    false,
    'https://www.a-star.edu.sg/Scholarships/for-graduate-studies/singapore-international-graduate-award-singa',
    NULL  -- deadline: unverified, must be read off the official page
),
(
    'ASEAN Undergraduate Scholarship (NUS)',
    'Singapore',
    ARRAY['Bachelors'],
    '{
      "tuition":               { "covered": true,  "detail": "Tuition fees after the MOE Tuition Grant subsidy" },
      "monthly_stipend":       { "covered": true,  "detail": "SGD 5,800 annual living allowance" },
      "airfare":               { "covered": false },
      "accommodation":         { "covered": true,  "detail": "SGD 3,000 annual accommodation allowance" },
      "health_insurance":      { "covered": false },
      "settling_in_allowance": { "covered": false },
      "research_grant":        { "covered": false },
      "visa_fees":             { "covered": false }
    }'::jsonb,
    '{
      "max_age": null,
      "min_gpa_4_scale": null,
      "min_work_experience_years": null,
      "language_test_required": true,
      "accepted_language_tests": ["TOEFL iBT", "IELTS"],
      "min_toefl_ibt": 92,
      "min_ielts": 6.5,
      "requires_university_admission_first": true,
      "requires_government_nomination": false,
      "requires_research_proposal": false,
      "restricted_to_nationalities": ["Brunei", "Cambodia", "Indonesia", "Laos", "Malaysia", "Myanmar", "Philippines", "Thailand", "Vietnam"],
      "notes": "Awarded on the strength of the NUS admission application -- there is no separate scholarship form."
    }'::jsonb,
    '[
      { "key": "nus_application", "label": "NUS undergraduate admission application", "required": true },
      { "key": "transcripts",     "label": "High school results / national exam certificates", "required": true },
      { "key": "toefl_ielts",     "label": "English proficiency score",              "required": true },
      { "key": "passport",        "label": "Passport bio page (ASEAN nationality)",  "required": true },
      { "key": "essays",          "label": "Personal statement and activity record", "required": false }
    ]'::jsonb,
    'Bonded: graduates must work for a Singapore-registered company for 3 years after graduation (MOE Tuition Grant obligation).',
    false,
    'https://www.nus.edu.sg/oam/scholarships/freshmen-international-students',
    NULL  -- deadline: unverified, must be read off the official page
);

-- ===========================================================================
-- VERIFIED ROWS
-- ---------------------------------------------------------------------------
-- The pattern for promoting a row out of 'unverified'. Only fill this in from
-- the programme's own timeline page -- and put THAT page in source_url, not the
-- homepage, so the next person can re-check the same thing you did.
-- ===========================================================================

-- Chevening 2027/28 cycle. Closing date and time read off the official
-- application-timeline page on 2026-08-02, which states: "The deadline for
-- applications is 6 October 2026 at 11:00 UTC." Supersedes an earlier
-- reconstructed deadline of 2026-11-03, which was wrong -- nothing happens in
-- November.
--
-- `source_url` points at the timeline page, NOT the homepage or the eligibility
-- page: it must be the page a re-checker has to read to confirm these dates.
UPDATE scholarships
SET opens_date          = '2026-08-04',
    deadline_date       = '2026-10-06',
    cycle_label         = '2027/28 intake',
    timeline            = '[
      { "key": "opens",         "label": "Applications open",              "date": "2026-08-04", "note": "11:00 UTC" },
      { "key": "closes",        "label": "Applications close",             "date": "2026-10-06", "note": "11:00 UTC -- the online system closes at this point" },
      { "key": "results",       "label": "Interview results",              "date": null,         "note": "Announced from mid-June 2027 onwards" },
      { "key": "unconditional", "label": "Unconditional UK offer deadline","date": "2027-07-08", "note": "17:00 BST -- in practice the real bottleneck" }
    ]'::jsonb,
    source_url          = 'https://www.chevening.org/scholarships/application-timeline/',
    verification_status = 'verified',
    last_verified_at    = '2026-08-02T00:00:00Z'
WHERE title = 'Chevening Scholarship';
