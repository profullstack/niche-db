import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/** ClinicalTrials.gov v2: studies as they are posted or updated. Keyless. */
export function toItem(s) {
  const id = s.protocolSection?.identificationModule ?? {};
  const st = s.protocolSection?.statusModule ?? {};
  const cond = s.protocolSection?.conditionsModule?.conditions ?? [];
  const sponsor = s.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name ?? null;
  const design = s.protocolSection?.designModule ?? {};
  const when = looseDate(
    st.lastUpdatePostDateStruct?.date ?? st.studyFirstPostDateStruct?.date ?? '',
  );
  return {
    externalId: id.nctId,
    kind: 'trial',
    title: id.briefTitle ?? id.nctId,
    summary:
      [
        sponsor,
        st.overallStatus?.toLowerCase().replace(/_/g, ' '),
        design.phases?.length ? design.phases.join('/').replace(/PHASE/g, 'Phase ') : null,
        design.enrollmentInfo?.count ? `${design.enrollmentInfo.count} participants` : null,
        (s.protocolSection?.descriptionModule?.briefSummary ?? '').slice(0, 300),
      ]
        .filter(Boolean)
        .join(' · ') || null,
    url: `https://clinicaltrials.gov/study/${id.nctId}`,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: 'day',
    tags: [
      'clinicaltrials',
      (st.overallStatus ?? '').toLowerCase().replace(/_/g, '-'),
      ...(design.phases ?? []).map((p) => p.toLowerCase().replace(/_/g, '-')),
      ...cond.slice(0, 5).map((c) => c.toLowerCase()),
    ].filter(Boolean),
    data: {
      nct: id.nctId,
      sponsor,
      status: st.overallStatus ?? null,
      conditions: cond,
      phases: design.phases ?? [],
      type: design.studyType ?? null,
      enrollment: design.enrollmentInfo?.count ?? null,
      start: st.startDateStruct?.date ?? null,
      completion: st.primaryCompletionDateStruct?.date ?? null,
    },
  };
}

export const clinicalTrials = defineAdapter({
  name: 'clinical-trials',
  title: 'ClinicalTrials.gov',
  collection: 'health',
  description:
    'Clinical studies as they are posted or change status on ClinicalTrials.gov, with sponsor, phase, conditions and enrollment. Keyless. Narrow with a condition or status.',
  docs: 'https://clinicaltrials.gov/data-api/api',
  kinds: ['trial'],
  cadenceMinutes: 60,
  configFields: [
    { key: 'condition', label: 'Condition', placeholder: 'diabetes' },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: ['', 'RECRUITING', 'NOT_YET_RECRUITING', 'COMPLETED', 'ACTIVE_NOT_RECRUITING'],
    },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'clinical-trials-updated', name: 'Clinical trials: recently updated' },
    {
      slug: 'clinical-trials-recruiting',
      name: 'Clinical trials: now recruiting',
      config: { status: 'RECRUITING' },
    },
  ],
  async pull({ config, http, log }) {
    const params = new URLSearchParams({
      sort: 'LastUpdatePostDate:desc',
      pageSize: '100',
      fields:
        'NCTId,BriefTitle,OverallStatus,LastUpdatePostDate,StudyFirstPostDate,Condition,LeadSponsorName,StartDate,PrimaryCompletionDate,Phase,StudyType,EnrollmentCount,BriefSummary',
    });
    if (config.condition) params.set('query.cond', String(config.condition));
    if (config.status) params.set('filter.overallStatus', String(config.status));
    const res = await http.json(`https://clinicaltrials.gov/api/v2/studies?${params}`);
    const items = (res.studies ?? []).map(toItem).filter((i) => i.externalId);
    log(`${items.length} studies`);
    return { items, note: `${items.length} studies` };
  },
});
