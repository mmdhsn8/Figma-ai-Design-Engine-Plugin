# Root cause and trace

The supplied incident reports a 390×844 viewport, a committed identity section, and one 6 px clipping finding. The reported absolute rectangles are parent (2639,6926,210,44) and child (2641,6959,206,17). With axis-aligned translation, local child bounds are (2,33,206,17) and its lower edge is 50. The actual Figma matrices, sizing modes, label and fonts were not available.

Chat selects structured generation, validates and persists each section before native apply. The renderer commits native section identity and then the controller obtains a fresh QA result. Visible retained content can therefore coexist with zero completed stages. Stage completion requires full screen verification; the fix keeps that requirement.
