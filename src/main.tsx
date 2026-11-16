import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
// Only the Mantine styles this app uses (the full sheet is ~290 KB). Order matters: base first,
// then shared parts, then components. Adding a Mantine component? Add its sheet here.
import '@mantine/core/styles/baseline.css';
import '@mantine/core/styles/default-css-variables.css';
import '@mantine/core/styles/global.css';
import '@mantine/core/styles/UnstyledButton.css';
import '@mantine/core/styles/VisuallyHidden.css';
import '@mantine/core/styles/Paper.css';
import '@mantine/core/styles/Popover.css';
import '@mantine/core/styles/CloseButton.css';
import '@mantine/core/styles/Group.css';
import '@mantine/core/styles/Flex.css';
import '@mantine/core/styles/Loader.css';
import '@mantine/core/styles/Overlay.css';
import '@mantine/core/styles/ModalBase.css';
import '@mantine/core/styles/ScrollArea.css';
import '@mantine/core/styles/Input.css';
import '@mantine/core/styles/InlineInput.css';
import '@mantine/core/styles/FloatingIndicator.css';
import '@mantine/core/styles/ActionIcon.css';
import '@mantine/core/styles/Button.css';
import '@mantine/core/styles/Modal.css';
import '@mantine/core/styles/Combobox.css';
import '@mantine/core/styles/PasswordInput.css';
import '@mantine/core/styles/SegmentedControl.css';
import '@mantine/core/styles/Switch.css';
import '@mantine/core/styles/Accordion.css';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import './reporter'; // picks up a reporter setup link before the URL is rewritten
import App from './App';

const theme = createTheme({
  primaryColor: 'blue',
  defaultRadius: 'md',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <App />
    </MantineProvider>
  </StrictMode>,
);
