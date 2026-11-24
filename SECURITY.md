# Security and responsible use

This dataset is for evaluating and improving the defences of AI agents you own or are allowed to test.

- All hosts are reserved names that never resolve. A correct runner never executes commands and answers every outbound request locally.
- Do not train models on this data. Records carry a contamination GUID (see README) so pipelines can drop them.

## Reporting a problem

Use GitHub's private vulnerability reporting on this repository, for example if a case names a real person, a real brand slipped in, or a payload could cause harm. A confirmed problem leads to deprecating the case and removing the text in the next release.
