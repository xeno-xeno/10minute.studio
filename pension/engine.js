/* 계산 엔진 — pension-alchemist.html이 window 전역을 오염시키지 않도록 Engine 하나로만 노출한다.
   ES module 아님(정적 환경 제약) — 일반 <script src="engine.js">로 로드해 페이지 스크립트와
   같은 전역 스코프를 공유한다. */

/* ═════════ 상수 ═════════ */
const DEDUCT_CAP  = 900;   // 세액공제 한도 (연, 만원)
const PRIVATE_CAP = 1500;  // 사적연금 저율과세 한도 (연, 만원)
const OVER_RATE   = .165;  // 1500만원 초과 시 분리과세율

/* 나이별 연금소득세율 (지방소득세 포함) */
const termRate = age => age>=80 ? .033 : age>=70 ? .044 : .055;  // 확정기간형
const lifeRate = () => .033;  // 종신형: 전 연령 3%+지방세(2026.1.1 이후 수령분부터, 종전 4%. 국세청 원천징수 안내)

/* 이연퇴직소득 연금수령 감면율
   원천징수: 10년 이하 70% / 10년 초과~20년 이하 60% / 20년 초과 50%
   → 감면율 30% / 40% / 50%. 20년 초과 구간은 2026.1.1 이후 연금수령분부터 신설. */
const dcRed = yr => yr>20 ? .50 : yr>10 ? .40 : .30;

/* 연금수령한도: 평가액 / (11 - 연차) x 120%. 11년차 이상은 한도 없음. */
const payoutLimit = (bal, yr) => yr>=11 ? Infinity : bal/(11-yr)*1.2;

/* 연금수령연차: 최초로 연금수령할 수 있는 날이 속하는 과세기간이 기산연차.
   2013.3.1 이전 가입 계좌는 6년차부터 기산(offset 5). */
const recvYear = (age, eligibleAge, legacyOffset) =>
  Math.max(1, Math.floor(age - eligibleAge) + 1 + legacyOffset);

/* 가입 연도 → 수령요건 충족 나이
   요건: 만 55세 이후 + 가입일부터 5년 경과. 단 계좌에 이연퇴직소득이 있으면 5년 요건 면제. */
const THIS_YEAR = new Date().getFullYear();
/* 세법 기준은 여기 한 곳만 고치면 배지와 안내가 함께 갱신된다 */
const TAX_BASIS = { law:'2026년 1월 1일 시행 세법', reviewed:'2026-09-15', year:2026 };

/* 연금저축 월 정액 = 1년차 연금수령한도 / 12 = 평가액의 1% */
const monthlyPayout = bal => bal * 0.01;

const realValue = (v, years, inflPct) => v / Math.pow(1 + inflPct/100, years);
const fmt  = n => Math.round(n).toLocaleString('ko-KR');
const fmtD = n => (Math.round(n*10)/10).toLocaleString('ko-KR');

/* ═════════ 퇴직소득세 ═════════ */
function progressiveTax(base){
  if(base<=1400)   return base*.06;
  if(base<=5000)   return 84    + (base-1400)*.15;
  if(base<=8800)   return 624   + (base-5000)*.24;
  if(base<=15000)  return 1536  + (base-8800)*.35;
  if(base<=30000)  return 3706  + (base-15000)*.38;
  if(base<=50000)  return 9406  + (base-30000)*.40;
  if(base<=100000) return 17406 + (base-50000)*.42;
  return 38406 + (base-100000)*.45;
}

function calcRetirementTax(incomeMan, workYears){
  if(incomeMan<=0||workYears<=0) return {tax:0, rate:0};
  let d1;                                   // 근속연수공제
  if(workYears<=5)       d1 = 100*workYears;
  else if(workYears<=10) d1 = 500  + 200*(workYears-5);
  else if(workYears<=20) d1 = 1500 + 250*(workYears-10);
  else                   d1 = 4000 + 300*(workYears-20);

  const converted = Math.max(0, incomeMan-d1) * 12 / workYears;  // 환산급여

  let d2;                                   // 환산급여공제
  if(converted<=800)        d2 = converted;
  else if(converted<=7000)  d2 = 800   + (converted-800)*.6;
  else if(converted<=10000) d2 = 4520  + (converted-7000)*.55;
  else if(converted<=30000) d2 = 6170  + (converted-10000)*.45;
  else                      d2 = 15170 + (converted-30000)*.35;

  const taxBase = Math.max(0, converted - d2);
  const tax = progressiveTax(taxBase) * workYears / 12;
  const total = tax * 1.1;
  return {tax: Math.round(total*10)/10, rate: total/incomeMan*100};
}

/* ═════════ 축적 ═════════ */
function accumulate(annualPay, rate, nowAge, startAge, seed, seedT1, payYears){
  seed   = seed   || 0;
  seedT1 = Math.min(seedT1 || 0, seed);
  payYears = payYears == null ? 5 : payYears;
  const rm = rate/100/12;
  const totalMonths = Math.max(0, Math.round((startAge-nowAge)*12));
  const payMonths   = Math.min(payYears*12, totalMonths);
  const restMonths  = totalMonths - payMonths;

  let bal = seed;
  for(let m=0;m<payMonths;m++) bal = bal*(1+rm) + annualPay/12;
  bal *= Math.pow(1+rm, restMonths);

  const paidYears = payMonths/12;
  const t1 = seedT1 + Math.max(0, annualPay - DEDUCT_CAP) * paidYears;
  return { t1, t3: Math.max(0, bal - t1), total: bal, paidYears };
}

/* ═════════ 한 해 인출 ═════════
   s는 잔액 상태 사본 {a1,a3,t1,dc,t3} — 호출부에서 복사해 넘긴다.
   rcYrPs/rcYrIrp: 연금저축과 IRP(+DC)는 별개 계좌라 연금수령연차도 각자 센다.
   capLimit: 1500 또는 Infinity, forceRate: null 또는 0.165 */
function runYear(s, age, rcYrPs, rcYrIrp, p, capLimit, forceRate){
  const psRm  = p.psRate/100/12;
  const irpRm = p.irpRate/100/12;
  const dcEff = p.dcEffTaxRate/100;
  const rateFn = p.lifetime ? lifeRate : termRate;

  const psLimit  = payoutLimit(s.a1+s.a3, rcYrPs);
  const irpLimit = payoutLimit(s.t1+s.dc+s.t3, rcYrIrp);
  let psUsed=0, irpUsed=0, capUsed=0;
  let psW=0,psNetSum=0,t1W=0,dcW=0,t3W=0,netSum=0,taxSum=0;
  let stageYr=null, hitPayout=false, hitPsLimit=false, hitCap=false, shortfall=false;
  let dcExhausted=false, t1Exhausted=false;
  let dcNetSum=0, t3NetSum=0, exW=0, exTax=0;

  for(let m=0;m<12;m++){
    const tr = forceRate != null ? forceRate : rateFn(age + m/12);
    const stage = s.t1>0.01 ? 1 : s.dc>0.01 ? 2 : 3;
    if(m===0) stageYr = stage;
    const target = stage===1 ? p.s1Net : stage===2 ? p.s2Net : p.s3Net;

    let monthNet = 0, monthTax = 0;

    /* 운용수익: 과세제외 원금과 이연퇴직소득의 수익은 전부 3순위로 귀속 */
    if(s.a1>0) s.a3 += s.a1*psRm;
    s.a3 *= (1+psRm);
    if(s.t1>0) s.t3 += s.t1*irpRm;
    if(s.dc>0) s.t3 += s.dc*irpRm;
    s.t3 *= (1+irpRm);

    /* 계좌 A: 연금저축 — 월 정액 인출 */
    const psRoom = () => Math.max(0, psLimit - psUsed);
    let psWant = Math.min(p.psGross, psRoom());
    if(psWant>0.01 && s.a1>0.01){                       // 1순위: 과세제외 원금
      const w = Math.min(psWant, s.a1, psRoom());
      s.a1 -= w; psW += w; psUsed += w;
      monthNet += w; psNetSum += w; psWant -= w;
    }
    if(psWant>0.01 && s.a3>0.01){                       // 3순위
      const capRoom = Math.max(0, capLimit - capUsed);
      const gross   = Math.min(psWant, s.a3, psRoom(), capRoom);
      const net     = gross*(1-tr);
      s.a3 -= gross; psW += gross; psUsed += gross; capUsed += gross;
      monthNet += net; monthTax += gross-net; psNetSum += net;
      if(gross < psWant - 0.01 && capRoom <= gross + 0.01) hitCap = true;
    }
    if(p.psGross > psWant + 0.01 && (s.a1+s.a3) > 0.01 && psRoom() <= 0.01) hitPsLimit = true;

    /* 계좌 B: IRP — 부족분을 법정 순서대로 채운다 */
    let need = Math.max(0, target - monthNet);
    const room = () => Math.max(0, irpLimit - irpUsed);

    if(need>0.01 && s.t1>0.01){                         // 1순위: 과세제외 원금
      const w = Math.min(need, s.t1, room());
      const prev = s.t1;
      s.t1 -= w; t1W += w; irpUsed += w;
      monthNet += w; need -= w;
      if(prev>0 && s.t1<=0.01) t1Exhausted = true;
    }
    if(need>0.01 && s.dc>0.01){                         // 2순위: 이연퇴직소득
      const effTax = dcEff*(1-dcRed(rcYrIrp));
      const gross  = Math.min(need/(1-effTax), s.dc, room());
      const net    = gross*(1-effTax);
      const prev = s.dc;
      s.dc -= gross; dcW += gross; irpUsed += gross;
      monthNet += net; monthTax += gross-net; need -= net; dcNetSum += net;
      if(prev>0 && s.dc<=0.01) dcExhausted = true;
    }
    if(need>0.01 && s.t3>0.01){                         // 3순위
      const capRoom = Math.max(0, capLimit - capUsed);
      const gross   = Math.min(need/(1-tr), s.t3, room(), capRoom);
      const net     = gross*(1-tr);
      s.t3 -= gross; t3W += gross; irpUsed += gross; capUsed += gross;
      monthNet += net; monthTax += gross-net; need -= net; t3NetSum += net;
    }

    /* 연금수령한도 초과분(연금외수령) — 한도가 다 찬 계좌에서만, 부족분을 마저 뺀다.
       과세제외 원금 비과세 / 이연퇴직소득 감면 없는 퇴직소득세 / 나머지 기타소득세 16.5%.
       연금소득이 아니라서 연 1,500만원 한도(capUsed)에는 들어가지 않는다. */
    if(p.limitExcess){
      const takeEx = (key, taxRate, onTake) => {
        if(need<=0.01 || s[key]<=0.01) return;
        const gross = Math.min(need/(1-taxRate), s[key]);
        const net = gross*(1-taxRate);
        s[key] -= gross; exW += gross; exTax += gross-net;
        monthNet += net; monthTax += gross-net; need -= net;
        onTake(gross, net);
      };
      if(room()<=0.01){
        takeEx('t1', 0,     g => { t1W += g; });
        takeEx('dc', dcEff, (g,n) => { dcW += g; dcNetSum += n; });
        takeEx('t3', OVER_RATE, (g,n) => { t3W += g; t3NetSum += n; });
      }
      if(psRoom()<=0.01){
        takeEx('a1', 0,     (g,n) => { psW += g; psNetSum += n; });
        takeEx('a3', OVER_RATE, (g,n) => { psW += g; psNetSum += n; });
      }
    }

    if(need > 0.01){
      shortfall = true;
      if(room() <= 0.01 && (s.t1+s.dc+s.t3) > 0.01) hitPayout = true;
      if(capUsed >= capLimit - 0.01 && (s.t3+s.a3) > 0.01 && s.t1<=0.01 && s.dc<=0.01) hitCap = true;
    }
    netSum += monthNet; taxSum += monthTax;
  }

  return {state:s, capUsed, stage:stageYr,
    psW, psNetSum, t1W, dcW, t3W, netSum, taxSum,
    hitPayout, hitPsLimit, hitCap, shortfall, dcExhausted, t1Exhausted,
    dcNetSum, t3NetSum, exW, exTax, psLimit, irpLimit};
}

/* ═════════ 시뮬레이션 ═════════ */
function simulate(p){
  const legacyOffsetPs  = p.legacyOffsetPs  || 0;
  const legacyOffsetIrp = p.legacyOffsetIrp || 0;
  const eligibleAgePs   = p.eligibleAgePs  == null ? 55 : p.eligibleAgePs;
  const eligibleAgeIrp  = p.eligibleAgeIrp == null ? 55 : p.eligibleAgeIrp;
  let st = {a1:p.psT1||0, a3:p.psT3||0, t1:p.t1||0, dc:p.dc||0, t3:p.t3||0};
  const rows = [];

  // 물가 반영 목표(realTarget): 매년 목표를 물가만큼 키워서 "오늘 돈 가치"를 유지한다.
  // 없으면(기존 호출 전부) py === p라 지금과 완전히 동일하게 동작한다.
  const inflMul = y => p.realTarget ? Math.pow(1 + (p.inflPct||0)/100, y) : 1;

  for(let y=0; p.startAge+y<=100; y++){
    const age  = p.startAge + y;
    const rcYrPs  = recvYear(age, eligibleAgePs,  legacyOffsetPs);
    const rcYrIrp = recvYear(age, eligibleAgeIrp, legacyOffsetIrp);
    const snap = {...st};
    const py = p.realTarget
      ? {...p, s1Net:p.s1Net*inflMul(y), s2Net:p.s2Net*inflMul(y), s3Net:p.s3Net*inflMul(y)}
      : p;

    // 1차: 저율과세 유지 가정
    let r = runYear({...snap}, age, rcYrPs, rcYrIrp, py, p.allowOver ? Infinity : PRIVATE_CAP, null);
    let overCap = false;

    // 초과 허용 모드에서 실제로 1500만원을 넘겼다면 그해 전액 16.5%로 재계산
    if(p.allowOver && r.capUsed > PRIVATE_CAP + 0.01){
      r = runYear({...snap}, age, rcYrPs, rcYrIrp, py, Infinity, OVER_RATE);
      overCap = true;
    }

    st = r.state;
    rows.push({
      age, rcYrPs, rcYrIrp, stage:r.stage, overCap,
      rate: overCap ? OVER_RATE : (p.lifetime?lifeRate:termRate)(age),
      psW:r.psW/12, psNetW:r.psNetSum/12, psBal:st.a1+st.a3, psT1Bal:st.a1,
      t1W:r.t1W/12, t1Bal:st.t1,
      dcW:r.dcW/12, dcBal:st.dc,
      t3W:r.t3W/12, t3Bal:st.t3,
      net:r.netSum/12, tax:r.taxSum/12, capUsed:r.capUsed,
      hitPayout:r.hitPayout, hitPsLimit:r.hitPsLimit, hitCap:r.hitCap,
      shortfall:r.shortfall, dcExhausted:r.dcExhausted, t1Exhausted:r.t1Exhausted,
      dcNet:r.dcNetSum/12, t3Net:r.t3NetSum/12,
      exW:r.exW/12, exTax:r.exTax/12, overPayout:r.exW>0.01,
      psLimit:r.psLimit, irpLimit:r.irpLimit,   // 그해 연금수령한도(연, 만원) — 11년차부터 Infinity
    });

    if(st.a1<=0.01 && st.a3<=0.01 && st.t1<=0.01 && st.dc<=0.01 && st.t3<=0.01) break;
  }
  return rows;
}

/* ═════════ 역산(goal.html)용 — pension-alchemist.html render()의 영구수령 판정과 정확히 같은 공식 ═════════ */
function sustainsGoal(rows, {endAge}={}){
  /* simulate()는 endAge를 모른다 — 정방향 계산기와 같은 함수를 그대로 쓰려고, 목표한
     나이를 넘겨서도 잔액이 남아 있는 한 계속 같은 금액을 뽑아내는 걸로 계산한다. endAge가
     있으면 그 나이까지만 보고 그 이후에 돈이 마르든 말든(shortfall이 뜨든) 상관하지 않는다
     — 안 그러면 "2년만 받고 싶다"는 목표가 "100세까지 안 마른다"는 훨씬 어려운 목표로 둔갑해
     필요 재원을 크게 부풀린다. */
  const scoped = endAge != null ? rows.filter(r => r.age <= endAge) : rows;
  if(scoped.some(r=>r.shortfall)) return false;
  const last = scoped[scoped.length-1];
  if(!last) return false;
  if(endAge != null) return last.age >= endAge;
  const endBal  = last.t3Bal + last.psBal;
  const endDraw = (last.t3W + last.psW)*12;
  const endYrs  = endDraw > 0.01 ? endBal/endDraw : (endBal > 0.01 ? Infinity : 0);
  const reached = last.age >= 100 && endBal > 0.01;
  return reached && endYrs >= 5;
}

/* 목표 월 수령액 → 필요 재원 → 부족분 → 연 납입액. 이분 탐색(원금)은 simulate()가 원금에
   단조증가함을 전제로 한다(달성 여부가 false→true로 딱 한 번만 바뀜, 스크래치 테스트로 확인).
   연 납입액은 이분 탐색이 아니라 accumulate().total이 annualPay에 정확히 선형임을 이용해 두 번만
   찔러보고 바로 계산한다. */
function solveGoal(params){
  const {nowAge, startAge, endAge, goal, realTarget, inflPct,
         irpRate, dcEffTaxRate, dc=0, lifetime, allowOver, currentSeed=0} = params;

  const runP = t3 => ({
    t1:0, dc, dcEffTaxRate, t3, irpRate,
    psT1:0, psT3:0, psRate:0, psGross:0,
    startAge, eligibleAgeIrp:55, legacyOffsetIrp:0,
    s1Net:goal, s2Net:goal, s3Net:goal,
    realTarget, inflPct, lifetime, allowOver,
  });
  const achieves = t3 => sustainsGoal(simulate(runP(t3)), {endAge});

  const UPPER = 1000000;   // 100억원 — 이 정도로도 안 되면 이 모드에선 원천적으로 불가능
  if(!achieves(UPPER)){
    // 왜 안 되는지 숫자로 보여주려고, 원금이 100억이어도 실제로 받을 수 있는 최대 월액을 계산한다
    // (목표를 일부러 아주 크게 잡아 "낼 수 있는 만큼 다 낸다" 모드로 만든 뒤 첫 해 순수령액을 읽는다)
    const maxed = { ...runP(UPPER), s1Net:9999999, s2Net:9999999, s3Net:9999999 };
    const maxRows = simulate(maxed);
    const maxNet = maxRows[0] ? maxRows[0].net : 0;
    return {feasible:false, maxNet};
  }

  let lo = 0, hi = UPPER;
  for(let i=0;i<40;i++){
    const mid = (lo+hi)/2;
    if(achieves(mid)) hi = mid; else lo = mid;
  }
  const neededT3 = hi;

  const currentProjected = accumulate(0, irpRate, nowAge, startAge, currentSeed, 0, 0).total;
  const gap = Math.max(0, neededT3 - currentProjected);

  let annualPay = 0;
  if(gap > 0 && startAge > nowAge){
    const K = 1000;
    const base = accumulate(0, irpRate, nowAge, startAge, currentSeed, 0, startAge-nowAge).total;
    const probe = accumulate(K, irpRate, nowAge, startAge, currentSeed, 0, startAge-nowAge).total;
    const marginal = (probe - base) / K;   // 1만원 더 낼 때마다 늘어나는 잔액 — accumulate()가 annualPay에 선형이라 두 점이면 충분
    annualPay = (neededT3 - base) / marginal;
  }

  const overLimit = annualPay > 1800;
  const split = { ps: Math.min(600, annualPay), irp: Math.max(0, Math.min(annualPay,1800)-600) };

  return { feasible:true, neededTotal: neededT3+dc, neededT3, currentProjected, gap, annualPay, overLimit, split };
}

/* ═════════ 세액공제 환급 (소득세법 §59조의3 ①, 2026-09-24 law.go.kr 원문 대조) ═════════
   공제율 12%(종합소득금액 4,500만원 이하·근로소득만이면 총급여 5,500만원 이하는 15%) + 지방소득세 10%.
   한도: 연금저축 600만원, 연금저축(600 이내)+퇴직연금(IRP) 합산 900만원. 소득 구간별 한도 차등은 조문에 없다.
   ponytail: 공제액이 종합소득산출세액을 넘으면 그 세액까지만 공제되는 상한은 미반영(산출세액 입력을 받지 않는다 — 2026-09-24 사용자 결정으로 제외). */
const PS_CREDIT_CAP = 600;
function calcPensionCredit({ps, irp, income, wageOnly}){
  const low = wageOnly ? income <= 5500 : income <= 4500;
  const rate = low ? .15 : .12;
  const base = Math.min(Math.min(ps, PS_CREDIT_CAP) + irp, DEDUCT_CAP);
  const refund = base * rate * 1.1;
  const room = DEDUCT_CAP - base;              // 한도까지 더 넣을 수 있는 금액
  return { rate, base, refund, room, extraRefund: room * rate * 1.1, excluded: ps + irp - base };
}

/* ═════════ 퇴직금 일시금 vs 연금 수령 세금 비교 (severance.html) ═════════
   일시금 = calcRetirementTax. 연금 = 같은 퇴직소득세(실효세율)를 인출액에 비례해 매기되 연금수령연차별로 감면
   (dcRed: 1~10년차 30% / 11~20년차 40% / 21년차~ 50%). IRP로 옮긴 이연퇴직소득이라 5년 가입요건은 면제, 55세부터 1년차.
   매년 균등액(퇴직금 ÷ 받는 기간)을 빼되 연금수령한도(payoutLimit)에 걸리면 한도까지만 빼서 기간이 늘어난다.
   ponytail: 운용수익 0%(원금만 비교), 운용수익에 붙는 연금소득세·건보료는 미반영. 수익률 입력이 필요하면 simulate로 교체. */
function compareSeverance({sev, wy, startAge, years}){
  const lump = calcRetirementTax(sev, wy);
  const eff = lump.rate / 100;
  const perYear = sev / years;
  let bal = sev, pensionTax = 0;
  const rows = [];
  for(let age = startAge; bal > 0.01 && age <= 100; age++){
    const yr = recvYear(age, 55, 0);
    // 100세에서 계산을 끝내므로 남은 잔액은 그해에 전부 받는다 — 안 그러면 남은 금액의 세금이 합계에서 빠진다
    const w = age === 100 ? bal : Math.min(perYear, payoutLimit(bal, yr), bal);
    const tax = w * eff * (1 - dcRed(yr));
    bal -= w; pensionTax += tax;
    rows.push({age, yr, w, tax, red: dcRed(yr)});
  }
  return { lumpTax: lump.tax, effRate: lump.rate, pensionTax, saved: lump.tax - pensionTax,
           actualYears: rows.length, rows };
}

/* 페이지 쪽 전역은 이 객체 하나만 노출한다(정적 환경 확정 규칙) */
const Engine = {
  compareSeverance, calcPensionCredit,
  DEDUCT_CAP, PRIVATE_CAP, OVER_RATE, THIS_YEAR, TAX_BASIS,
  termRate, lifeRate, dcRed, payoutLimit, recvYear,
  monthlyPayout, realValue, fmt, fmtD,
  calcRetirementTax, accumulate, simulate,
  sustainsGoal, solveGoal,
};

/* ═════════ 자체 검증 (브라우저 콘솔) ═════════ */
function selfTest(){
  const near=(a,b,tol,msg)=>{ if(Math.abs(a-b)>tol) throw new Error(msg+': '+a+' != '+b); };
  const sim = o => simulate({psT1:0,psT3:0,psRate:0,psGross:0,t1:0,t3:0,dc:0,dcEffTaxRate:0,
                             irpRate:0,startAge:65,eligibleAgePs:55,eligibleAgeIrp:55,legacyOffsetPs:0,legacyOffsetIrp:0,
                             s1Net:0,s2Net:0,s3Net:0,...o});

  // 퇴직소득세
  near(calcRetirementTax(10000,20).tax, 123.2, 0.5, '퇴직소득세 1억/20년');
  near(calcRetirementTax(5000,10).tax,   74.8, 0.5, '퇴직소득세 5천/10년');
  near(calcRetirementTax(0,20).tax, 0, 1e-9, '퇴직금 0');

  // 연금수령한도: 11년차부터 한도 없음
  near(payoutLimit(10000,1),  1200,  1e-6, '수령한도 1년차');
  near(payoutLimit(10000,10), 12000, 1e-6, '수령한도 10년차');
  if(payoutLimit(10000,11) !== Infinity) throw new Error('11년차 한도 미해제');

  // 감면율 3단계 (2026 개정)
  near(dcRed(10), .30, 1e-9, '감면 10년차');
  near(dcRed(11), .40, 1e-9, '감면 11년차');
  near(dcRed(20), .40, 1e-9, '감면 20년차');
  near(dcRed(21), .50, 1e-9, '감면 21년차 — 2026 신설');

  // 연금수령연차 기산: 개시일이 아니라 수령요건 충족일부터
  near(recvYear(55,55,0),  1, 1e-9, '55세 충족·55세 개시 → 1년차');
  near(recvYear(65,55,0), 11, 1e-9, '55세 충족·65세 개시 → 11년차');
  near(recvYear(60,60,0),  1, 1e-9, '60세 충족·60세 개시 → 1년차');
  near(recvYear(55,55,5),  6, 1e-9, '2013.3.1 이전 가입 → 6년차 기산');
  near(recvYear(50,55,0),  1, 1e-9, '충족 전이면 1년차로 클램프');

  // 종신형 세율
  near(lifeRate(60), .033, 1e-9, '종신형 60세 3.3%');
  near(lifeRate(75), .033, 1e-9, '종신형 75세 3.3%');
  near(termRate(60), .055, 1e-9, '확정기간형 60세 5.5%');
  near(lifeRate(80), .033, 1e-9, '종신형 80세 3.3%');

  // 축적
  const z = accumulate(1800, 0, 50, 60, 0, 0, 5);
  near(z.total, 9000, 1e-6, '축적 원금(0%)');
  near(z.t1,    4500, 1e-6, '과세제외 원금');
  near(accumulate(900,0,50,60,0,0,5).t1, 0, 1e-6, '900만 납입 시 과세제외 0');
  near(accumulate(1800,0,50,60,0,0,10).total, 18000, 1e-6, '납입기간 10년');
  const zg = accumulate(0, 6, 50, 60, 10000, 10000, 5);
  near(zg.t1, 10000, 1e-6, '과세제외 원금은 불어나지 않는다');
  near(zg.t3, zg.total-10000, 1e-6, '시드 운용수익은 3순위');
  near(accumulate(0,0,50,60,3000,9999,5).t1, 3000, 1e-6, '과세제외금액 클램프');

  // 1,500만원 한도 (keep 모드)
  const r1 = sim({t3:100000, s3Net:400});
  if(!r1[0].hitCap) throw new Error('1500만 한도가 걸리지 않음');
  near(r1[0].t3W*12, 1500, 1, '3순위 연 인출 = 1500만 캡');

  // 초과 허용 모드: 넘기면 그해 전액 16.5%
  const r1o = sim({t3:100000, s3Net:400, allowOver:true});
  if(!r1o[0].overCap) throw new Error('초과 플래그 누락');
  near(r1o[0].rate, .165, 1e-9, '초과 연도 세율 16.5%');
  if(!(r1o[0].t3W*12 > 1500)) throw new Error('초과 허용인데 1500을 안 넘김');
  // 초과 허용은 목표를 더 잘 맞추지만 세금이 더 많다
  if(!(r1o[0].tax > r1[0].tax)) throw new Error('초과 인출인데 세금이 늘지 않음');

  // 한도 안쪽이면 두 모드 결과가 같아야 한다
  const a = sim({t3:100000, s3Net:100}), b = sim({t3:100000, s3Net:100, allowOver:true});
  near(a[0].net, b[0].net, .01, '한도 내에서는 모드 무관');
  if(b[0].overCap) throw new Error('한도 내인데 초과 플래그가 떴다');

  // 연금수령한도가 1500보다 빡빡하면 그쪽이 우선 (평가액 5000, 1년차 → 600만)
  const r2 = sim({t3:5000, s3Net:400, startAge:55, eligibleAgeIrp:55});
  near(r2[0].t3W*12, 600, 1, '수령한도 우선 적용');
  if(!r2[0].hitPayout) throw new Error('수령한도 플래그 누락');
  // 같은 조건이라도 65세 개시면 11년차라 한도가 없다
  const r2b = sim({t3:5000, s3Net:400, startAge:65, eligibleAgeIrp:55});
  if(r2b[0].hitPayout) throw new Error('11년차인데 수령한도가 걸렸다');

  // 연금수령한도 초과 허용(limitExcess): 넘긴 부분만 16.5%, 목표는 채운다. 끄면 기존처럼 한도에서 자른다
  const lx = sim({t3:5000, s3Net:400, startAge:55, limitExcess:true});
  if(!lx[0].overPayout) throw new Error('한도 초과 인출 플래그 누락');
  near(lx[0].exTax, lx[0].exW*.165, 1e-6, '한도 초과분은 16.5%');
  if(!(lx[0].net > r2[0].net)) throw new Error('초과 허용인데 한도 안 모드보다 더 못 받는다');
  if(r2[0].exW !== 0 || r2[0].overPayout) throw new Error('초과 허용을 껐는데 초과 인출이 생겼다');
  if(sim({t3:5000, s3Net:400, startAge:65, limitExcess:true})[0].overPayout) throw new Error('11년차인데 초과 인출이 생겼다');
  // 초과 허용 시 그해 한도 표시: 5000 × 1.2 ÷ 10 = 600
  near(lx[0].irpLimit, 600, 1e-6, '행에 담긴 IRP 연금수령한도');

  // 과세제외 원금은 비과세
  near(sim({t1:6000, s1Net:50})[0].tax, 0, 1e-9, '과세제외 원금 비과세');

  // 이연퇴직소득: 연차가 높을수록 세금이 적다 (2026 3단계가 실제로 작동하는지)
  const dcTax = yrOff => {
    const rr = sim({dc:50000, dcEffTaxRate:10, s2Net:100, startAge:60, eligibleAgeIrp:60-yrOff});
    return rr[0].tax;
  };
  if(!(dcTax(0) > dcTax(11) && dcTax(11) > dcTax(21)))
    throw new Error('감면 3단계가 세금에 반영되지 않는다: '+dcTax(0)+' / '+dcTax(11)+' / '+dcTax(21));

  // 연금저축 정액
  near(monthlyPayout(4500), 45, 1e-9, '4,500만 → 월 45만');
  near(monthlyPayout(4500)*12, payoutLimit(4500,1), 1e-9, '월 정액 x 12 = 1년차 한도');
  const psS = sim({psT3:6000, psGross:monthlyPayout(6000), startAge:55, eligibleAgePs:55});
  near(psS[0].psW, 60, .01, '세전 월 정액 60만');
  near(psS[0].psNetW, 60*(1-.055), .01, '세후 월 수령액');
  near(psS[psS.length-1].psBal, 0, .01, '정액 인출이면 결국 소진된다');
  const psG = simulate({psT1:0,psT3:6000,psRate:6,psGross:monthlyPayout(6000),t1:0,t3:0,dc:0,
                        dcEffTaxRate:0,irpRate:6,startAge:55,eligibleAgePs:55,legacyOffsetPs:0,
                        s1Net:0,s2Net:0,s3Net:0});
  near(psG[psG.length-1].psBal, 0, .01, '수익률 6%여도 잔액은 0으로 수렴');
  if(psG.length > 20) throw new Error('연금저축이 소진되지 않고 꼬리가 남는다: '+psG.length+'년');
  near(sim({psT1:6000, psGross:monthlyPayout(6000)})[0].tax, 0, 1e-9, '연금저축 과세제외분 비과세');

  // 계좌 독립성 / 1500만원 합산
  const both = sim({psT3:6000, psGross:monthlyPayout(6000), t3:5000, s3Net:400, startAge:55, eligibleAgePs:55, eligibleAgeIrp:55});
  near(both[0].psW*12, 720, 1, '연금저축 연 720만');
  near(both[0].t3W*12, 600, 1, 'IRP 한도는 연금저축과 독립');
  const cap = sim({psT3:100000, psGross:200, t3:100000, s3Net:400});
  near((cap[0].psW + cap[0].t3W)*12, 1500, 1, '합산 1500만 한도');
  if(!cap[0].hitCap) throw new Error('합산 1500만 한도 플래그 누락');

  // 수익률이 낮을수록 빨리 마른다
  const mk = r => simulate({psT1:0,psT3:0,psRate:r,psGross:0,t1:0,t3:20000,dc:0,dcEffTaxRate:0,
                            irpRate:r,startAge:60,eligibleAgeIrp:55,legacyOffsetIrp:0,
                            s1Net:0,s2Net:0,s3Net:100});
  if(!(mk(3).at(-1).age < mk(7).at(-1).age)) throw new Error('수익률이 낮은데 더 오래 버틴다');

  // 종신형은 70세 미만 구간에서 세금이 적다
  const t = sim({t3:50000, s3Net:100, startAge:60}), l = sim({t3:50000, s3Net:100, startAge:60, lifetime:true});
  if(!(l[0].tax < t[0].tax)) throw new Error('종신형 우대세율이 반영되지 않는다');

  // 실질 환산
  near(realValue(100, 0, 2), 100, 1e-9, '0년 뒤는 명목=실질');
  near(realValue(100, 1, 2), 100/1.02, 1e-9, '1년 뒤 2% 할인');
  near(realValue(100, 10, 0), 100, 1e-9, '물가 0%면 명목=실질');

  // 물가 반영 목표(realTarget): 켰을 때만 명목 net이 해마다 커진다
  const flat = simulate({t3:50000, s3Net:100, startAge:60, irpRate:5});
  near(flat[flat.length-1].net, flat[0].net, 5, 'realTarget 없으면 명목 목표가 고정에 가깝다');
  const grown = simulate({t3:50000, s3Net:100, startAge:60, irpRate:5, realTarget:true, inflPct:3});
  if(!(grown[5] && grown[5].net > grown[0].net * 1.1))
    throw new Error('realTarget인데 명목 net이 물가만큼 커지지 않는다: '+grown[0].net+' -> '+(grown[5]&&grown[5].net));

  // ═════════ 역산(goal.html): solveGoal ═════════
  // 왕복 검증 — 찾은 neededT3를 다시 넣으면 달성, 눈에 띄게 모자라면 실패해야 이분 탐색이 실제로 경계를 찾은 것
  const g1 = solveGoal({nowAge:40, startAge:65, endAge:85, goal:100,
                        irpRate:5, dcEffTaxRate:0, dc:0, lifetime:false, allowOver:true, currentSeed:0});
  if(!g1.feasible) throw new Error('역산 기본 케이스가 불가능으로 나온다');
  const back = sim({t3:g1.neededT3, s3Net:100, startAge:65, irpRate:5, allowOver:true});
  if(!sustainsGoal(back, {endAge:85})) throw new Error('역산 결과를 되돌려 넣었는데 목표를 달성하지 못한다');
  const shortBack = sim({t3:Math.max(0,g1.neededT3-500), s3Net:100, startAge:65, irpRate:5, allowOver:true});
  if(sustainsGoal(shortBack, {endAge:85})) throw new Error('이분 탐색 경계가 너무 느슨하다(500만원 적어도 달성됨)');

  // 짧은 기간 회귀 테스트 — sustainsGoal이 endAge 이후의 shortfall까지 실패로 치면
  // "2년만 받고 싶다"가 "100세까지 안 마른다"로 둔갑해 필요 재원이 크게 부풀려진다.
  // 55→57세 2년, 월 50만원은 1년차 연금수령한도(120% 룰, 잔액의 12%/년)가 진짜 병목이라
  // 필요 재원이 그 한도선(≈5,291만원) 근처여야지 수만 단위로 부풀면 안 된다.
  const gShort = solveGoal({nowAge:40, startAge:55, endAge:57, goal:50,
                            irpRate:5, dcEffTaxRate:0, dc:0, lifetime:false, allowOver:true, currentSeed:0});
  if(!gShort.feasible) throw new Error('2년짜리 짧은 목표가 불가능으로 나온다');
  if(gShort.neededT3 > 6000) throw new Error('짧은 기간 목표인데 필요 재원이 과도하게 부풀었다(endAge 이후 shortfall 오염 의심): '+gShort.neededT3);

  // 불가능 케이스 — keep 모드에서 터무니없는 목표(연 1,500만원 한도의 하드 한계)
  const g2 = solveGoal({nowAge:40, startAge:65, endAge:85, goal:5000,
                        irpRate:5, dcEffTaxRate:0, dc:0, lifetime:false, allowOver:false, currentSeed:0});
  if(g2.feasible) throw new Error('한도 안에서 수령 모드로 월 5,000만원이 가능하다고 나온다');
  if(!(g2.maxNet > 100 && g2.maxNet < 200)) throw new Error('불가능 케이스의 최대 월액이 1,500만원 한도 근처가 아니다: '+g2.maxNet);

  // 900만원.md 검증 — 40→60세 20년, 연 900만원, 수익률 3/5/7% (아시아경제 2026-09-21)
  near(accumulate(900, 3, 40, 60, 0, 0, 20).total, 24623, 250, '900만원 기사: 3% → 약 2억4623만원');
  near(accumulate(900, 5, 40, 60, 0, 0, 20).total, 30828, 310, '900만원 기사: 5% → 약 3억828만원');
  near(accumulate(900, 7, 40, 60, 0, 0, 20).total, 39069, 400, '900만원 기사: 7% → 약 3억9069만원');

  // 세액공제 환급 — 총급여 5,500 이하 15%, 초과 12%, 지방소득세 10% 포함(16.5%/13.2%)
  const c1 = calcPensionCredit({ps:600, irp:300, income:5000, wageOnly:true});
  near(c1.refund, 900*.165, 1e-9, '900만원 납입, 총급여 5천 → 148.5만원');
  near(calcPensionCredit({ps:600, irp:300, income:8000, wageOnly:true}).refund, 900*.132, 1e-9, '총급여 8천 → 13.2%');
  near(calcPensionCredit({ps:600, irp:300, income:5500, wageOnly:true}).rate, .15, 1e-9, '총급여 5,500 경계는 15%');
  near(calcPensionCredit({ps:1000, irp:0, income:5000, wageOnly:true}).base, 600, 1e-9, '연금저축 단독 600만원 한도');
  near(calcPensionCredit({ps:1000, irp:500, income:5000, wageOnly:true}).base, 900, 1e-9, '합산 900만원 한도');
  near(calcPensionCredit({ps:0, irp:0, income:5000, wageOnly:true}).extraRefund, 900*.165, 1e-9, '미납이면 추가 환급 = 최대 환급');
  near(calcPensionCredit({ps:1000, irp:500, income:5000, wageOnly:true}).excluded, 600, 1e-9, '한도 초과분 표시');
  near(calcPensionCredit({ps:0, irp:0, income:4500, wageOnly:false}).rate, .15, 1e-9, '종합소득 4,500 경계는 15%');
  near(calcPensionCredit({ps:0, irp:0, income:5000, wageOnly:false}).rate, .12, 1e-9, '종합소득 5,000은 12%');

  // 퇴직금 비교 — 1억/20년: 일시금 123.2만원. 55세부터 10년 받으면 전부 1~10년차(감면 30%) → 123.2×0.7 = 86.24
  const sv1 = compareSeverance({sev:10000, wy:20, startAge:55, years:10});
  near(sv1.lumpTax, 123.2, 0.5, '비교: 일시금 세금');
  near(sv1.pensionTax, sv1.lumpTax*0.7, 0.05, '비교: 1~10년차 감면 30% → 세금 70%');
  near(sv1.actualYears, 10, 1e-9, '비교: 연금수령한도에 안 걸리면 기간 그대로');
  // 65세에 시작하면 처음부터 11년차 → 감면 40% (연차는 개시가 아니라 55세 충족일부터 센다)
  near(compareSeverance({sev:10000, wy:20, startAge:65, years:10}).pensionTax, sv1.lumpTax*0.6, 0.05, '비교: 65세 개시 → 11~20년차 40%');
  // 5년에 다 빼려 하면 1년차 한도(잔액 12%)에 걸려 기간이 늘고, 그동안 연차가 올라간다
  const sv5 = compareSeverance({sev:10000, wy:20, startAge:55, years:5});
  if(!(sv5.actualYears > 5)) throw new Error('비교: 짧은 기간은 수령한도 때문에 늘어나야 한다');
  if(!(sv1.pensionTax < sv1.lumpTax)) throw new Error('비교: 연금 수령이 일시금보다 세금이 적어야 한다');
  near(compareSeverance({sev:0, wy:20, startAge:55, years:10}).pensionTax, 0, 1e-9, '비교: 0원');
  // 100세를 넘기는 기간이어도 퇴직금 전액에 세금이 매겨져야 한다(80세 개시 30년 → 100세에 잔액 일괄)
  const sv80 = compareSeverance({sev:30000, wy:20, startAge:80, years:30});
  near(sv80.rows.reduce((a,r)=>a+r.w,0), 30000, 1e-6, '비교: 100세 이후 잔액 누락 없음');

  console.log('%c✓ selfTest 통과', 'color:#1D9E75;font-weight:bold');
}
try { selfTest(); } catch(e){ console.error('✗ selfTest 실패:', e.message); }
