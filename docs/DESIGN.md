# port-commander — 설계 문서

작성일: 2026-07-28

## 목적
로컬에서 개발 서버/프론트를 여러 개 띄우다 보면 어떤 포트가 뭔지 헷갈리고, 종료도 번거롭다.
이 앱은 한 곳에서 **리스닝 포트 확인 → 종료 → 프론트 미리보기 → 서버 로그 → Claude 명령**까지 처리한다.

## 핵심 제약 (정직하게)
macOS에서 이미 외부(다른 터미널)에서 실행 중인 프로세스의 stdout을 가로챌 방법은 없다.
따라서 로그는 두 갈래로 나눈다.
- **자동 스캔으로 감지된 외부 포트**: 종료 / 정보 / (웹이면) 미리보기 O, 실시간 로그 X
- **이 앱에서 직접 실행한 서버**: 실시간 stdout/stderr 로그 O

## 기능 (MVP)
1. 포트 대시보드 — `lsof`로 LISTEN 포트 자동 스캔(포트/PID/프로세스명/경로), 3초 폴링 + 수동 새로고침
2. 종료 — SIGTERM → 안 죽으면 SIGKILL, 다중 선택 일괄 종료
3. 웹 판별 — 각 포트에 HTTP GET 프로브, 응답 오면 `web`, 아니면 `srv` 뱃지
4. 프론트 미리보기 — web 포트를 앱 내 `<webview>`로 임베드 + [새 창으로 열기](별도 BrowserWindow, 개발자도구)
5. 서버 로그 — 앱에서 "서버 실행"(명령어+작업경로)한 프로세스의 실시간 로그 + 종료
6. Claude 명령 — 하단 프롬프트 → `claude -p ... --output-format stream-json` 실행, 결과 스트리밍

## 기술 스택
- Electron + 순수 JS/HTML/CSS (번들러 없음)
- 보안: contextIsolation on, nodeIntegration off, preload의 contextBridge로 IPC만 노출, webviewTag on
- main 프로세스: 포트스캔 / kill / 프로세스 spawn / claude 실행
- PATH 문제 회피: 시작 시 로그인 셸에서 실제 PATH를 읽어 spawn에 주입

## 구조
```
src/
  main/
    main.js           Electron main, 윈도우 + IPC 핸들러
    env.js            로그인 셸 PATH / claude 경로 확보
    portScanner.js    lsof 스캔 + HTTP 프로브
    processManager.js 관리 프로세스 spawn/로그/종료
    claudeRunner.js   claude -p 스트리밍 실행
  preload/
    preload.js        contextBridge API
  renderer/
    index.html
    styles.css
    renderer.js
```

## 안 넣는 것 (YAGNI)
원격/도커 포트, 히스토리 DB, 멀티 세션, 인증.
