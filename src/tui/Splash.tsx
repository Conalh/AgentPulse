/**
 * Startup splash shown for ~900ms before the dashboard renders.
 *
 * Pure presentation. The App component owns the timing (a useState +
 * setTimeout) and swaps from Splash to the dashboard on the next tick.
 */

import React from 'react';
import { Box, Text } from 'ink';

const RAGE_ART = [
  ' ██████╗   █████╗   ██████╗  ███████╗',
  ' ██╔══██╗ ██╔══██╗ ██╔════╝  ██╔════╝',
  ' ██████╔╝ ███████║ ██║  ███╗ █████╗  ',
  ' ██╔══██╗ ██╔══██║ ██║   ██║ ██╔══╝  ',
  ' ██║  ██║ ██║  ██║ ╚██████╔╝ ███████╗',
  ' ╚═╝  ╚═╝ ╚═╝  ╚═╝  ╚═════╝  ╚══════╝',
];

export function Splash(): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="center" paddingY={2}>
      {RAGE_ART.map((line, i) => (
        <Text key={i} color="red" bold>
          {line}
        </Text>
      ))}
      <Box marginTop={2} flexDirection="column" alignItems="center">
        <Box>
          <Text dimColor>— </Text>
          <Text bold color="cyan">
            AgentPulse
          </Text>
          <Text dimColor> —</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>live trajectory verdict · local · no LLM</Text>
        </Box>
      </Box>
    </Box>
  );
}
