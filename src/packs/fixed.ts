// Hand-picked topic packs. Words resolve through the bundled dictionary like any search;
// levels come from frequency rank, so each pack can be filtered to the learner's level.
// Konglish items teach the real English for loanwords that mean something else in Korean.

export interface PackWord {
  w: string; // English word or phrase to learn (and save)
  k?: string; // Konglish form as Koreans say it, e.g. "핸드폰"
  note?: string; // short Korean explanation
}

export interface FixedPack {
  id: string;
  icon: string;
  title: { ko: string; en: string };
  desc: { ko: string; en: string };
  words: PackWord[];
}

const list = (s: string): PackWord[] => s.split(',').map((w) => ({ w: w.trim() })).filter((x) => x.w);

export const FIXED_PACKS: FixedPack[] = [
  {
    id: 'workplace',
    icon: '💼',
    title: { ko: '직장', en: 'Workplace' },
    desc: { ko: '회의, 일정, 보고, 동료와의 대화에 자주 쓰는 말', en: 'Meetings, schedules, reports and talking with coworkers' },
    words: list(`meeting, deadline, schedule, reschedule, postpone, colleague, coworker, manager, supervisor,
      department, client, customer, presentation, report, agenda, contract, negotiate, budget, invoice,
      salary, raise, bonus, promotion, overtime, shift, resign, hire, interview, resume, benefits,
      vacation, sick leave, commute, confirm, attach, follow up, in charge, responsible, deliver, feedback`),
  },
  {
    id: 'medical',
    icon: '🏥',
    title: { ko: '병원·약국', en: 'Medical' },
    desc: { ko: '진료 예약, 증상 설명, 약 처방에 필요한 말', en: 'Booking a visit, describing symptoms, getting medicine' },
    words: list(`appointment, symptom, fever, cough, headache, sore throat, runny nose, allergy, allergic,
      prescription, pharmacy, pharmacist, refill, dose, side effect, painkiller, antibiotic, insurance,
      blood pressure, blood test, check-up, diagnosis, treatment, recover, injury, sprain, rash, nausea,
      dizzy, infection, chronic, emergency, ambulance, surgery, vaccine, clinic, specialist, referral, x-ray`),
  },
  {
    id: 'housing',
    icon: '🏠',
    title: { ko: '집·은행', en: 'Housing & banking' },
    desc: { ko: '집 구하기, 월세, 공과금, 계좌와 송금', en: 'Renting, bills, accounts and transfers' },
    words: list(`rent, lease, landlord, tenant, security deposit, utilities, bill, mortgage, furnished,
      move in, move out, repair, maintenance, leak, neighbor, account, checking account, savings account,
      balance, deposit, withdraw, transfer, ATM, PIN, interest rate, loan, credit, credit card,
      debit card, statement, fee, overdraft, branch, teller, budget, tax, receipt, refund`),
  },
  {
    id: 'visa',
    icon: '🛂',
    title: { ko: '비자·이민', en: 'Visa & immigration' },
    desc: { ko: '비자 신청, 서류, 체류 자격, 갱신', en: 'Applications, documents, status and renewals' },
    words: list(`visa, passport, permit, work permit, residence, resident, citizen, citizenship,
      immigration, application, apply, document, form, embassy, consulate, sponsor, status, extension,
      expire, expiration date, renew, renewal, fingerprint, biometrics, approve, deny, appeal,
      signature, customs, declare, green card, social security number, identification, proof`),
  },
  {
    id: 'toefl',
    icon: '🎓',
    title: { ko: 'TOEFL 핵심 어휘', en: 'TOEFL essentials' },
    desc: { ko: '시험 독해·강의에 자주 나오는 학술 어휘', en: 'Academic words common in TOEFL reading and lectures' },
    words: list(`analyze, hypothesis, significant, consequence, fluctuate, phenomenon, inevitable,
      substantial, demonstrate, interpret, predominant, subsequent, contemporary, inherent, criteria,
      approximately, assume, attribute, comprise, constrain, contradict, derive, diminish, distinct,
      emerge, empirical, enhance, evaluate, exceed, facilitate, hierarchy, implication, indicate,
      integrate, mechanism, migrate, notion, perceive, preliminary, prevalent, sustain, sufficient,
      ultimately, valid, whereas, adapt, abundant`),
  },
  {
    id: 'konglish',
    icon: '🔤',
    title: { ko: '콩글리시 바로잡기', en: 'Konglish false friends' },
    desc: {
      ko: '한국에서 쓰는 외래어지만 영어로는 다르게 말하는 표현',
      en: 'Loanwords Koreans use that mean something else in English',
    },
    words: [
      { w: 'cell phone', k: '핸드폰', note: 'hand phone은 영어에서 안 써요. cell phone 또는 그냥 phone.' },
      { w: 'you can do it', k: '파이팅', note: 'fighting은 "싸움". 응원할 때는 You can do it! / Go for it!' },
      { w: 'on the house', k: '서비스', note: '식당에서 공짜로 주는 것은 on the house 또는 complimentary.' },
      { w: 'bottoms up', k: '원샷', note: '한 번에 마시자고 할 때는 Bottoms up!' },
      { w: 'window shopping', k: '아이쇼핑', note: 'eye shopping은 영어에 없어요.' },
      { w: 'laptop', k: '노트북', note: 'notebook은 "공책"이에요.' },
      { w: 'mechanical pencil', k: '샤프', note: 'sharp는 "날카로운"이라는 형용사예요.' },
      { w: 'apartment', k: '아파트', note: 'apart는 "떨어져서"라는 뜻이에요.' },
      { w: 'studio', k: '원룸', note: '방 하나짜리 집은 studio (apartment).' },
      { w: 'cheating', k: '커닝', note: 'cunning은 "교활한". 시험 부정행위는 cheating.' },
      { w: 'autograph', k: '사인 (연예인)', note: '연예인 사인은 autograph, 서류 서명은 signature.' },
      { w: 'signature', k: '사인 (서류)', note: 'sign은 동사 "서명하다"나 "표지판"이에요.' },
      { w: 'comedian', k: '개그맨', note: 'gagman은 영어에서 거의 안 써요.' },
      { w: 'stapler', k: '호치키스', note: 'Hotchkiss는 회사 이름이에요.' },
      { w: 'rearview mirror', k: '백미러', note: 'back mirror는 콩글리시예요.' },
      { w: 'steering wheel', k: '핸들', note: 'handle은 문 손잡이 같은 "손잡이"예요.' },
      { w: 'convertible', k: '오픈카', note: '지붕이 열리는 차는 convertible.' },
      { w: 'remote control', k: '리모컨', note: '보통 그냥 remote라고 해요.' },
      { w: 'air conditioner', k: '에어컨', note: '줄여서 AC라고도 해요.' },
      { w: 'gym', k: '헬스장', note: 'health는 "건강". 운동하다는 work out.' },
      { w: 'work out', k: '헬스하다', note: '"I work out at the gym."처럼 써요.' },
      { w: 'selfie', k: '셀카', note: 'self camera는 콩글리시예요.' },
      { w: 'blind date', k: '미팅·소개팅', note: 'meeting은 "회의"예요.' },
      { w: 'nail polish', k: '매니큐어', note: 'manicure는 손톱 관리 자체를 말해요.' },
      { w: 'sweatpants', k: '츄리닝', note: 'training은 "훈련"이에요. 위아래 한 벌은 tracksuit.' },
      { w: 'dress shirt', k: '와이셔츠', note: 'Y-shirt는 영어에 없어요.' },
      { w: 'treadmill', k: '런닝머신', note: 'running machine은 콩글리시예요.' },
      { w: 'outlet', k: '콘센트', note: 'consent는 "동의"예요. 영국에서는 socket.' },
      { w: 'plastic bag', k: '비닐봉지', note: 'vinyl은 레코드판 재질을 말해요.' },
      { w: 'motorcycle', k: '오토바이', note: 'autobike는 영어에 없어요.' },
      { w: 'cast', k: '깁스', note: '부러진 팔에 하는 것은 cast.' },
      { w: 'blender', k: '믹서', note: 'mixer는 반죽 섞는 기계(제빵용)를 말해요.' },
      { w: 'stove', k: '가스레인지', note: 'gas range도 쓰지만 보통 stove.' },
      { w: 'debit card', k: '체크카드', note: 'check card는 콩글리시예요.' },
      { w: 'sticky note', k: '포스트잇', note: 'Post-it은 상표 이름이에요.' },
      { w: 'social media', k: 'SNS', note: '영어권에서는 SNS보다 social media라고 해요.' },
      { w: 'split the bill', k: '더치페이', note: '"Let\'s split the bill."이 자연스러워요.' },
      { w: 'part-time job', k: '아르바이트', note: 'Arbeit는 독일어예요.' },
      { w: 'wake-up call', k: '모닝콜', note: 'morning call은 콩글리시예요.' },
      { w: 'warranty', k: 'A/S', note: '수리 서비스는 repair service, 보증은 warranty.' },
    ],
  },
];
