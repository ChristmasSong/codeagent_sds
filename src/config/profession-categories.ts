/**
 * Profession category configuration.
 *
 * Each category has a unique `value` (stored in DB), localized labels,
 * and optional sub-categories for finer-grained selection on the settings page.
 *
 * Sources: prioritized as DB config → this built-in default.
 * The admin panel can override this list via the `profession_categories`
 * config key (JSON format matching the exported type).
 */

export interface ProfessionSubCategory {
  value: string;
  label: Record<string, string>; // locale → display text
}

export interface ProfessionCategory {
  /** Stable identifier stored in the user.profession column */
  value: string;
  /** Localized display labels */
  label: Record<string, string>;
  /** Optional sub-categories for the settings page detail selector */
  children?: ProfessionSubCategory[];
}

/** Built-in default category list. Sorted by anticipated usage frequency. */
export const professionCategories: ProfessionCategory[] = [
  {
    value: 'engineering',
    label: { en: 'Engineering', zh: '工科' },
    children: [
      {
        value: 'engineering:cs',
        label: { en: 'Computer / Software', zh: '计算机 / 软件' },
      },
      {
        value: 'engineering:electronics',
        label: { en: 'Electronics / Telecom', zh: '电子 / 通信' },
      },
      {
        value: 'engineering:mechanical',
        label: { en: 'Mechanical / Automation', zh: '机械 / 自动化' },
      },
      {
        value: 'engineering:civil',
        label: { en: 'Civil / Architecture', zh: '土木 / 建筑' },
      },
      {
        value: 'engineering:chemical',
        label: { en: 'Chemical / Materials', zh: '化工 / 材料' },
      },
      {
        value: 'engineering:aerospace',
        label: { en: 'Aerospace', zh: '航空航天' },
      },
      {
        value: 'engineering:other',
        label: { en: 'Other Engineering', zh: '其他工科' },
      },
    ],
  },
  {
    value: 'science',
    label: { en: 'Science', zh: '理科' },
    children: [
      {
        value: 'science:math',
        label: { en: 'Mathematics / Statistics', zh: '数学 / 统计' },
      },
      { value: 'science:physics', label: { en: 'Physics', zh: '物理学' } },
      { value: 'science:chemistry', label: { en: 'Chemistry', zh: '化学' } },
      { value: 'science:biology', label: { en: 'Biology', zh: '生物学' } },
      {
        value: 'science:earth',
        label: { en: 'Earth / Environment', zh: '地球 / 环境科学' },
      },
      {
        value: 'science:other',
        label: { en: 'Other Science', zh: '其他理科' },
      },
    ],
  },
  {
    value: 'finance',
    label: { en: 'Finance & Economics', zh: '金融 / 经济' },
    children: [
      { value: 'finance:banking', label: { en: 'Banking', zh: '银行' } },
      {
        value: 'finance:securities',
        label: { en: 'Securities / Investment', zh: '证券 / 投资' },
      },
      { value: 'finance:insurance', label: { en: 'Insurance', zh: '保险' } },
      {
        value: 'finance:accounting',
        label: { en: 'Accounting / Auditing', zh: '财务 / 审计' },
      },
      { value: 'finance:economics', label: { en: 'Economics', zh: '经济学' } },
      { value: 'finance:fintech', label: { en: 'FinTech', zh: '金融科技' } },
      {
        value: 'finance:other',
        label: { en: 'Other Finance', zh: '其他金融' },
      },
    ],
  },
  {
    value: 'business',
    label: { en: 'Business & Management', zh: '商业 / 管理' },
    children: [
      {
        value: 'business:marketing',
        label: { en: 'Marketing', zh: '市场营销' },
      },
      {
        value: 'business:hr',
        label: { en: 'Human Resources', zh: '人力资源' },
      },
      {
        value: 'business:operations',
        label: { en: 'Operations', zh: '运营管理' },
      },
      {
        value: 'business:consulting',
        label: { en: 'Strategy Consulting', zh: '战略咨询' },
      },
      {
        value: 'business:supply_chain',
        label: { en: 'Supply Chain / Logistics', zh: '供应链 / 物流' },
      },
      {
        value: 'business:sales',
        label: { en: 'Sales / BD', zh: '销售 / 商务拓展' },
      },
      {
        value: 'business:entrepreneur',
        label: { en: 'Entrepreneur / Founder', zh: '创业者 / 创始人' },
      },
      {
        value: 'business:other',
        label: { en: 'Other Business', zh: '其他商业' },
      },
    ],
  },
  {
    value: 'healthcare',
    label: { en: 'Healthcare', zh: '医疗 / 健康' },
    children: [
      {
        value: 'healthcare:clinical',
        label: { en: 'Clinical Medicine', zh: '临床医学' },
      },
      { value: 'healthcare:nursing', label: { en: 'Nursing', zh: '护理' } },
      { value: 'healthcare:pharmacy', label: { en: 'Pharmacy', zh: '药学' } },
      {
        value: 'healthcare:public_health',
        label: { en: 'Public Health', zh: '公共卫生' },
      },
      {
        value: 'healthcare:mental',
        label: { en: 'Mental Health', zh: '心理健康' },
      },
      {
        value: 'healthcare:other',
        label: { en: 'Other Healthcare', zh: '其他医疗' },
      },
    ],
  },
  {
    value: 'education',
    label: { en: 'Education & Academia', zh: '教育 / 学术' },
    children: [
      {
        value: 'education:professor',
        label: { en: 'Professor / Researcher', zh: '高校教师 / 科研' },
      },
      {
        value: 'education:k12',
        label: { en: 'K-12 Teacher', zh: '中小学教师' },
      },
      {
        value: 'education:admin',
        label: { en: 'Education Administration', zh: '教育管理' },
      },
      {
        value: 'education:edtech',
        label: { en: 'EdTech / Online', zh: '在线教育' },
      },
      {
        value: 'education:other',
        label: { en: 'Other Education', zh: '其他教育' },
      },
    ],
  },
  {
    value: 'legal',
    label: { en: 'Legal', zh: '法律' },
    children: [
      { value: 'legal:attorney', label: { en: 'Attorney', zh: '律师' } },
      {
        value: 'legal:corporate',
        label: { en: 'Corporate Legal', zh: '企业法务' },
      },
      {
        value: 'legal:judiciary',
        label: { en: 'Judiciary / Law Enforcement', zh: '司法 / 执法' },
      },
      {
        value: 'legal:research',
        label: { en: 'Legal Research', zh: '法学研究' },
      },
      { value: 'legal:other', label: { en: 'Other Legal', zh: '其他法律' } },
    ],
  },
  {
    value: 'arts_design',
    label: { en: 'Arts, Design & Media', zh: '文化 / 艺术 / 设计' },
    children: [
      {
        value: 'arts_design:graphic',
        label: { en: 'Graphic / Visual Design', zh: '平面 / 视觉设计' },
      },
      {
        value: 'arts_design:industrial',
        label: { en: 'Industrial Design', zh: '工业设计' },
      },
      {
        value: 'arts_design:ui_ux',
        label: { en: 'UI / UX Design', zh: 'UI / UX 设计' },
      },
      {
        value: 'arts_design:writing',
        label: { en: 'Writing / Editing', zh: '写作 / 编辑' },
      },
      {
        value: 'arts_design:film_music',
        label: { en: 'Film / Music', zh: '影视 / 音乐' },
      },
      {
        value: 'arts_design:photography',
        label: { en: 'Photography', zh: '摄影' },
      },
      {
        value: 'arts_design:other',
        label: { en: 'Other Arts', zh: '其他文化 / 艺术' },
      },
    ],
  },
  {
    value: 'government',
    label: { en: 'Government & Nonprofit', zh: '政府 / 公共事务' },
    children: [
      {
        value: 'government:civil_service',
        label: { en: 'Civil Service', zh: '公务员' },
      },
      {
        value: 'government:policy',
        label: { en: 'Public Policy', zh: '公共政策' },
      },
      {
        value: 'government:international',
        label: { en: 'International Organization', zh: '国际组织' },
      },
      {
        value: 'government:nonprofit',
        label: { en: 'Nonprofit / NGO', zh: '非营利组织' },
      },
      {
        value: 'government:other',
        label: { en: 'Other Public Service', zh: '其他公共事务' },
      },
    ],
  },
  {
    value: 'student',
    label: { en: 'Student', zh: '学生' },
    children: [
      {
        value: 'student:undergrad',
        label: { en: 'Undergraduate', zh: '本科生' },
      },
      {
        value: 'student:grad',
        label: { en: 'Graduate / PhD', zh: '研究生 / 博士' },
      },
      {
        value: 'student:vocational',
        label: { en: 'Vocational Training', zh: '职业培训' },
      },
      {
        value: 'student:other',
        label: { en: 'Other Student', zh: '其他学生' },
      },
    ],
  },
  {
    value: 'freelancer',
    label: { en: 'Freelancer & Self-employed', zh: '自由职业 / 个体' },
    children: [
      {
        value: 'freelancer:dev',
        label: { en: 'Independent Developer', zh: '独立开发者' },
      },
      {
        value: 'freelancer:creator',
        label: { en: 'Creator / Influencer', zh: '自媒体 / 创作者' },
      },
      {
        value: 'freelancer:consultant',
        label: { en: 'Freelance Consultant', zh: '自由咨询' },
      },
      {
        value: 'freelancer:trader',
        label: { en: 'Sole Trader', zh: '个体商户' },
      },
      {
        value: 'freelancer:other',
        label: { en: 'Other Freelancer', zh: '其他自由职业' },
      },
    ],
  },
  {
    value: 'other',
    label: { en: 'Other', zh: '其他' },
    children: [
      { value: 'other:retired', label: { en: 'Retired', zh: '已退休' } },
      {
        value: 'other:not_working',
        label: { en: 'Not Currently Working', zh: '暂时未工作' },
      },
      {
        value: 'other:prefer_not',
        label: { en: 'Prefer Not to Say', zh: '不便透露' },
      },
      { value: 'other:other', label: { en: 'Other', zh: '其他' } },
    ],
  },
];

/**
 * Resolve a localized label for the given profession value and locale.
 * Falls back to the value itself when no match is found.
 */
export function getProfessionLabel(
  value: string,
  locale: string = 'en'
): string {
  for (const cat of professionCategories) {
    if (cat.value === value) {
      return cat.label[locale] || cat.label.en || value;
    }
    if (cat.children) {
      for (const sub of cat.children) {
        if (sub.value === value) {
          return sub.label[locale] || sub.label.en || value;
        }
      }
    }
  }
  return value;
}
