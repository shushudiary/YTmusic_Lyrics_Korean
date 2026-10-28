# 🎵 YTmusic_Lyrics_Korean

<p align="center">
  <img src="icon128.png" width="100" alt="YTmusic_Lyrics_Korean Logo" />
</p>

<p align="center">
  <b>YouTube Music Chrome Extension for Korean</b><br>
  YouTube Music 웹에서 즐기는 Apple Music 스타일의 실시간 싱크 가사 & 전체화면 플레이어
</p>

---

## 📖 소개 (About)

**YTmusic_Lyrics_Korean**은 YouTube Music 웹 버전(`https://music.youtube.com/*`)에서 Apple Music 스타일의 유려한 **실시간 싱크 가사(Time-synced Lyrics)**와 **전체화면 몰입형 플레이어**를 제공하는 Chrome 확장 프로그램입니다.

국내 K-Pop 음원 특성에 맞춘 고도화된 메타데이터 정제 알고리즘, 5대 멀티 소스 선착순 레이싱 엔진, 그리고 스마트한 언어 판별 기술을 탑재하여 언제나 정확하고 빠른 원어 가사를 제공합니다.

---

## ✨ 주요 기능 (Key Features)

### 1. 🍎 Apple Music 스타일 전체화면 모드
- **앰비언트 블러 배경**: 현재 재생 중인 앨범 아트워크 색상을 추출하여 유려하게 일렁이는 동적 블롭 및 글래스모피즘(Glassmorphism) 배경 적용.
- **초고주사율 가사 동기화**: `requestAnimationFrame`과 이진 탐색(Binary Search) 알고리즘을 결합한 50ms 정밀 싱크, 거리별 가우시안 블러 및 활성 라인 하이라이팅.
- **3초 무활동 몰입형 모드**: 전체화면 진입 후 3초 동안 마우스 조작이 없으면 마우스 커서, 상단 알약(볼륨/윈도우 컨트롤), 하단 전환 알약, 가사 스크롤바가 자동으로 페이드아웃되어 음악 감상에만 집중할 수 있는 환경 제공.
- **기존 UI 완벽 보존**: 순정 YouTube Music 전체화면 단축키(`f`) 및 앨범 호버 전체화면 버튼과 완벽 연동.

### 2. ⚡ 5대 멀티 소스 선착순 레이싱 파이프라인
가사 검색 지연을 없애기 위해 5대 가사 소스를 병렬로 동시 호출하며, 가장 먼저 유효한 싱크 가사를 반환한 소스를 0.2~0.4초 만에 즉시 채택합니다.
- **YouTube Music 공식 모바일 TimedLyrics** (무결점 실시간 가사)
- **알송 (Alsong)** (K-Pop/국내 음원 특화)
- **LRCLIB** (글로벌 오픈소스 LRC 데이터베이스)
- **NetEase Cloud Music (왕이윈)** (J-Pop, 글로벌 음원 보완)
- **QQ Music** (글로벌 음원 보완)

### 3. 🌐 스마트 언어/문자셋 판별 & 번역줄 필터링
- **J-Pop & C-Pop 100% 보존**: 히라가나/가타카나 및 메타데이터 한자 분석을 통해 일본곡과 중국곡은 차단 없이 완벽 지원.
- **중국어 오매칭 차단**: 한국곡, 팝송, 일본곡에서 엉뚱한 중국어 동명이곡이나 번역 가사가 나오는 현상 원천 차단.
- **이중언어(Bilingual) 번역 분리**: 원문과 중국어 번역이 함께 적힌 가사에서 번역 줄만 자동으로 제거하고 원어 가사만 정제하여 출력.

### 4. 🎯 가사 제공자(Provider) 수동 변경 메뉴
- 가사 탭이나 전체화면 가사 화면에서 **마우스 우클릭** 시 커스텀 컨텍스트 메뉴가 열려 원하는 가사 서버(알송, LRCLIB, YTM 공식 등)를 직접 선택 가능.

### 5. 💾 스마트 로컬 캐싱 & 앨범 표지 배지
- **조건부 로컬 저장**: '좋아요(Liked)' 표시 곡이나 보관함(Saved/Library) 곡의 가사를 로컬(`chrome.storage.local`)에 영구 저장하여 다음 재생 시 **0.01초(네트워크 지연 없음)** 만에 즉시 렌더링.
- **앨범 표지 배지 표시**: 가사가 저장된 곡은 재생목록, 보관함, 검색 결과 등 앨범 표지 우측 상단에 확장 프로그램 아이콘(`♪`) 배지 자동 표시 (플레이어 영역 제외).
- **확장 프로그램 설정 팝업**: 툴바 아이콘을 클릭하여 가사 로컬 저장 기능 ON/OFF 및 저장된 가사 곡 수 확인/비우기 지원.

---

## 📂 프로젝트 구조 (Project Structure)

```
YTmusic_Lyrics_Korean/
├── manifest.json       # Manifest V3 설정 및 권한 명시
├── background.js      # 가사 API 통신, DNR 헤더 수정, 캐싱 및 선착순 레이싱
├── content.js         # YTM DOM 감지, 가사 렌더링, 전체화면 모달, 우클릭 메뉴
├── styles.css         # Apple Music 스타일 UI, GPU 애니메이션, 글래스모피즘
├── popup.html         # 설정 팝업 UI
├── popup.js           # 설정 팝업 이벤트 및 스토리지 제어
├── icon16.png         # 확장 프로그램 아이콘 (16x16)
├── icon32.png         # 확장 프로그램 아이콘 (32x32)
├── icon48.png         # 확장 프로그램 아이콘 (48x48)
└── icon128.png        # 확장 프로그램 아이콘 (128x128)
```

---

## 🚀 설치 및 사용 방법 (Installation)

1. 저장소를 클론하거나 ZIP 파일로 다운로드 후 압축을 풉니다.
   ```bash
   git clone https://github.com/your-username/YTmusic_Lyrics_Korean.git
   ```
2. Chrome 또는 Chromium 기반 브라우저(Edge, Whale, Brave 등)를 열고 주소창에 `chrome://extensions`를 입력합니다.
3. 우측 상단의 **개발자 모드(Developer mode)** 토글을 활성화합니다.
4. 좌측 상단의 **압축해제된 확장 프로그램을 로드합니다(Load unpacked)** 버튼을 클릭합니다.
5. 다운로드한 프로젝트 폴더를 선택합니다.
6. [YouTube Music](https://music.youtube.com)에 접속하여 음악을 감상하세요!

---

## 🎮 단축키 및 인터랙션 안내

- **전체화면 열기/닫기**: 
  - 재생 중인 곡의 앨범 커버에 마우스를 올리고 나타나는 **기존 전체화면 버튼** 클릭
  - YouTube Music 순정 전체화면 단축키 `f` 입력
  - 전체화면 닫기: `ESC` 키 또는 좌상단 `✕` / `⧉` 버튼 클릭
- **가사 싱크 조절**:
  - 우측 상단 `•••` 버튼 또는 가사 탭 상단 툴바에서 `-0.5s`, `-0.1s`, `+0.1s`, `+0.5s` 미세 조정
- **가사 제공자 변경**:
  - 가사 화면 아무 곳이나 **마우스 우클릭**하여 원하는 제공자 선택
- **가사 / 재생목록 전환**:
  - 전체화면 우측 하단의 말풍선(`💬`) / 목록(`☰`) 알약 버튼 클릭

---

## 🔒 개인정보 및 보안 (Privacy & Permissions)

본 확장 프로그램은 사용자의 개인정보나 로그인 계정 정보를 수집 및 외부로 전송하지 않습니다.
- `storage`: 좋아요/보관함 곡의 가사 텍스트 로컬 캐싱 및 사용자 설정 저장
- `declarativeNetRequestWithHostAccess`: 외부 가사 API(NetEase, QQ Music, Alsong 등) 통신 시 CORS 제한 우회 및 필수 헤더 처리

---

## 📄 라이선스 (License)

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
