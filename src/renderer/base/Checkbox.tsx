import { Checkbox } from "@mui/material"
import styled from "styled-components"

interface Props {
  checked: boolean,
  onChange: (newVal: boolean) => void,
  label?: string
}

export default function LabelledCheckbox({checked, onChange, label}: Props) {
  return (
    <Root>
      {label && <Label>{label}</Label>}
      <Checkbox checked={checked} onChange={e => onChange(e.target.checked)}/>
    </Root>
  )
}

const Root = styled.div`
  display: flex;
  align-items: center;
`

const Label = styled.div`
  
`