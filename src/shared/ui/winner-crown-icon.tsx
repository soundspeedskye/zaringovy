import Svg, { Path } from "react-native-svg";

export function WinnerCrownIcon({ size = 24 }: { size?: number }) {
  return (
    <Svg height={size} viewBox="0 0 100 100" width={size}>
      <Path d="M16 31 34 47 50 18 66 47 84 31 77 75H23Z" fill="#F5CE3F" />
      <Path d="M23 70h54v12c0 4-3 7-7 7H30c-4 0-7-3-7-7Z" fill="#DFAA36" />
    </Svg>
  );
}
