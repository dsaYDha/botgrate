// 대기·지구 상수. 탄도는 ICAO 표준 대기(해면, 15°C)를 기준으로 한다.
// 소리 전달 속도는 기획서 지정값(343 m/s)을 쓴다 — REALISM_NOTES.md 참고.

export const ATMOSPHERE = {
  temperatureC: 15.0,
  pressurePa: 101325,
  density: 1.2250, // kg/m³, ICAO 표준 해면 밀도
  // 탄도용 음속(마하수 계산): sqrt(1.4 * 287.05 * 288.15)
  speedOfSoundBallistic: 340.294, // m/s
  gravity: 9.80665, // m/s², 표준 중력
  // 소리 전파 속도(오디오 지연용)
  soundSpeed: 343.0, // m/s
  // 코리올리 계산용 위도(북위). 평원 방풍림 지대를 가정한 값.
  latitudeDeg: 48.0,
  earthRotation: 7.2921159e-5, // rad/s
};
