# 10minute.studio — Project Guide

## 프로젝트 개요
GitHub Pages 기반 인디 앱 소개 사이트.
- URL: https://xeno-xeno.github.io/10minute.studio/
- 순수 HTML/CSS/JS (빌드 도구 없음, 서버 없음)
- 모든 동적 기능은 Vanilla JS로 구현
- 답변은 항상 한국어로. 단답형/두괄식/결론위주로

## SEO / AEO 작업 규칙

**SEO·AEO·키워드 관련 작업은 아래 볼트 문서를 먼저 읽고 시작할 것. 작업 후에는 반드시 그 문서를 갱신할 것.**

```
mac : /Users/xenoxeno/Library/CloudStorage/Dropbox/앱/remotely-save/xenoNote/10minute.studio/website_AEO.md
win : E:\Project_dev\DEV_APP\xenoNote\10minute.studio\website_AEO.md
```
(같은 볼트가 remotely-save로 동기화된다. 작업 중인 기기의 경로를 쓸 것)

- **이 문서가 SEO/AEO의 단일 소스(source of truth)다.** 진단 · 키워드 전략(문학시계 / 2048 클러스터) · 경쟁 구도 · 실행 체크리스트 · 진행 현황이 모두 여기 있다
- **작업 전**: Read해서 이미 처리된 항목(`[x]`, 취소선)과 §7 "진행 현황"을 확인 — 중복 작업 방지
- **작업 후**: 체크박스 갱신 + §7 진행 현황에 날짜·내용 추가. 코드만 고치고 문서를 안 고치면 다음 세션이 같은 걸 다시 제안한다
- **사실이 바뀌면 정정 블록을 남길 것** (예: "광고 있음" 확인 → "광고 없는 2048" 키워드 폐기 경고). 잘못된 전제로 세운 전략은 지우지 말고 왜 폐기됐는지 함께 남긴다
- 검증되지 않은 앱 사실(가격·광고·인앱결제·최소 OS·용량 등)은 **추측해서 쓰지 말고 물어볼 것**. 페이지에 없으면 AI도 인용할 수 없고, 지어내면 스토어 리뷰에서 역풍이 온다
- 웹(SEO/AEO) 키워드와 스토어(ASO) 키워드는 함께 관리한다 — ASC/ASO 문구 원본은 `README.md`

## 호스트 루트 파일 (`_hostroot/`)

`https://xeno-xeno.github.io/` 루트에 올라가는 파일(`index.html`·`robots.txt`·`app-ads.txt`·네이버 인증파일)은 **별도 레포**(`xeno-xeno.github.io`) 소관이고, 그 레포는 로컬에 클론돼 있지 않다.

- 루트용 파일은 **`_hostroot/`를 임시로 만들어** 거기서 편집 → 사용자가 수동 업로드/커밋 → **작업 끝나면 `_hostroot/` 삭제**
- **이 폴더는 이 사이트에 배포되지 않는다.** 배포 안 되는 폴더를 남겨두면 레포가 혼란스러워지므로 상시 보관하지 않는다
- 폴더가 평소엔 없으므로 **루트의 현재 상태·파일 목록·변경 이력은 볼트 §9가 단일 소스다.** 루트 파일 작업 전 반드시 §9를 읽을 것

## 개발 원칙

### 환경
- GitHub Pages 정적 환경 — Node.js, 번들러, 외부 런타임 없음
- CDN 의존 최소화, 오프라인/느린 네트워크 고려

### 스타일
- 라이트/다크모드: `@media (prefers-color-scheme: dark)` + CSS 변수(`--bg`, `--text` 등)로 처리
- 반응형: `max-width: 768px` 브레이크포인트 기준, `clamp()` 활용
- 모든 페이지 동일한 CSS 변수 체계와 컴포넌트 스타일 유지

### JavaScript
- `const` / `let` 사용, `var` 금지
- 템플릿 리터럴 사용
- 콜백은 화살표 함수 사용
- DOM 조작은 `getElementById` / `querySelector` 직접 사용

### 애니메이션
- CSS 애니메이션 우선, JS는 클래스 토글로만 제어
- `requestAnimationFrame` 기반 카운트업 등 성능 고려
- GitHub Pages에서 JS 로드 전 깜빡임(FOUC) 방지 고려
