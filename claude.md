# 10minute.studio — Project Guide

## 프로젝트 개요
GitHub Pages 기반 인디 앱 소개 사이트.
- URL: https://xeno-xeno.github.io/10minute.studio/
- 순수 HTML/CSS/JS (빌드 도구 없음, 서버 없음)
- 모든 동적 기능은 Vanilla JS로 구현

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
