import Keyboard from 'react-simple-keyboard';
import 'react-simple-keyboard/build/css/index.css';

type VirtualKeyboardProps = {
  rows: string[];
  display: Record<string, string>;
  onKeyPress: (button: string) => void;
  buttonTheme: Array<{ class: string; buttons: string }>;
  themeClass: string;
};

export default function VirtualKeyboard({
  rows,
  display,
  onKeyPress,
  buttonTheme,
  themeClass
}: VirtualKeyboardProps) {
  return (
    <Keyboard
      layout={{ default: rows }}
      display={display}
      onKeyPress={onKeyPress}
      buttonTheme={buttonTheme}
      disableButtonHold
      theme={`hg-theme-default webtmux-keyboard ${themeClass}`}
    />
  );
}
