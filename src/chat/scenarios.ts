export interface Scenario {
  id: string;
  icon: string;
  title: { ko: string; en: string };
  desc: { ko: string; en: string };
  /** Who Gemini plays and the situation (English, for the system prompt). */
  role: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'interview',
    icon: '💼',
    title: { ko: '취업 면접', en: 'Job interview' },
    desc: { ko: '면접관과 경력, 장점, 희망 조건 이야기하기', en: 'Talk about your experience and strengths' },
    role: 'a friendly hiring manager interviewing the learner for a job that fits their background',
  },
  {
    id: 'doctor',
    icon: '🩺',
    title: { ko: '병원 진료', en: "Doctor's visit" },
    desc: { ko: '증상 설명하고 처방 받기', en: 'Describe symptoms and get a prescription' },
    role: 'a calm family doctor seeing the learner, who has come in because they are not feeling well',
  },
  {
    id: 'landlord',
    icon: '🏠',
    title: { ko: '집주인과 대화', en: 'Landlord' },
    desc: { ko: '월세, 수리, 계약 문제 상의하기', en: 'Rent, repairs and the lease' },
    role: "the learner's landlord, talking about the apartment: rent, the lease, a repair that is needed",
  },
  {
    id: 'coworker',
    icon: '☕',
    title: { ko: '동료와 스몰토크', en: 'Coworker small talk' },
    desc: { ko: '휴게실에서 주말, 일, 계획 이야기', en: 'Weekend plans, work, everyday chat' },
    role: 'a friendly coworker making small talk with the learner in the break room',
  },
  {
    id: 'restaurant',
    icon: '🍽️',
    title: { ko: '식당 주문', en: 'Restaurant' },
    desc: { ko: '주문하고 요청하고 계산하기', en: 'Order, ask for things, pay the bill' },
    role: 'a server at a casual restaurant taking care of the learner from seating to paying the bill',
  },
  {
    id: 'free',
    icon: '💬',
    title: { ko: '자유 대화', en: 'Free talk' },
    desc: { ko: '아무 주제나 편하게 이야기하기', en: 'Chat about anything' },
    role: 'a warm, curious conversation partner chatting with the learner about their life and interests',
  },
];
