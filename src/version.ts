// 앱 버전의 원본은 package.json 하나다. 빌드할 때 이 파일로 코드에 들어오고(named import라 version만 번들된다),
// 설치 파일의 버전(tauri.conf.json의 version이 package.json을 가리킴)도 같은 값을 쓴다.
import { version } from "../package.json";

export const APP_NAME = "ToyTerm";
export const APP_VERSION: string = version;
